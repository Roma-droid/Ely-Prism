package dev.figuraely;

import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Makes the self-signed backend certificate trusted automatically, so a friend
 * only has to drop the mod jar in — no manual {@code keytool} step.
 *
 * <p>Figura talks to its backend over {@code https://} and {@code wss://}, and
 * both its {@code HttpClient} and its (neovisionaries) WebSocket use the JVM's
 * <em>default</em> trust — i.e. {@code <java.home>/lib/security/cacerts} (or the
 * store named by {@code javax.net.ssl.trustStore}). So we make that default
 * trust include our certificate.
 *
 * <p>This must run in the Fabric {@code preLaunch} entrypoint, before Minecraft
 * performs any TLS: the default {@code SSLContext} is initialised lazily on the
 * first TLS use and then cached, so touching the truststore afterwards would be
 * too late for the current session.
 *
 * <p>Two strategies, tried in order, and everything is best-effort — a failure
 * never stops the game:
 * <ol>
 *   <li><b>Truststore file</b> — add the cert to the JVM cacerts on disk
 *       (idempotent). Reliable for launcher-bundled JREs (writable, password
 *       {@code changeit}).</li>
 *   <li><b>In-memory fallback</b> — if the file is read-only or password-protected
 *       differently, install a process-wide default {@code SSLContext} that trusts
 *       the system CAs <em>plus</em> our cert for this session only.</li>
 * </ol>
 *
 * <p>We only ever add one specific certificate — we never install an
 * all-trusting trust manager — so normal TLS verification is unaffected.
 */
final class FiguraElyTrust {

    static final String ALIAS = "figura-ely";
    // Uses a plain logger name (no Minecraft classes) so it is safe in preLaunch.
    private static final Logger LOGGER = LoggerFactory.getLogger("figura-ely-trust");

    private FiguraElyTrust() {}

    /** Ensure the backend certificate is trusted by this JVM. Never throws. */
    static void install() {
        try {
            X509Certificate cert = loadCert();
            if (cert == null) {
                LOGGER.info("[Figura Ely] No bundled or override certificate found — skipping trust setup "
                        + "(only needed for a self-signed / private backend).");
                return;
            }
            if (addToTrustStoreFile(cert)) {
                LOGGER.info("[Figura Ely] Backend certificate is trusted (installed into the JVM truststore).");
                return;
            }
            if (installDefaultSslContext(cert)) {
                LOGGER.info("[Figura Ely] Backend certificate is trusted for this session (in-memory SSLContext).");
                return;
            }
            LOGGER.warn("[Figura Ely] Could not auto-trust the backend certificate. If Figura fails to connect, "
                    + "import 'config/figura-ely.crt' into your Java cacerts manually (see the mod README).");
        } catch (Throwable t) {
            LOGGER.warn("[Figura Ely] Certificate trust setup failed; continuing without it.", t);
        }
    }

    /** Prefer an external {@code config/figura-ely.crt} (rotatable), else the bundled resource. */
    private static X509Certificate loadCert() throws Exception {
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        Path override = FabricLoader.getInstance().getConfigDir().resolve("figura-ely.crt");
        if (Files.isReadable(override)) {
            try (InputStream in = Files.newInputStream(override)) {
                LOGGER.info("[Figura Ely] Using certificate override {}", override);
                return (X509Certificate) cf.generateCertificate(in);
            }
        }
        try (InputStream in = FiguraElyTrust.class.getResourceAsStream("/figura-ely.crt")) {
            if (in == null) return null;
            return (X509Certificate) cf.generateCertificate(in);
        }
    }

    private static Path trustStorePath() {
        String prop = System.getProperty("javax.net.ssl.trustStore");
        if (prop != null && !prop.isBlank() && !prop.equalsIgnoreCase("NONE")) {
            return Paths.get(prop);
        }
        return Paths.get(System.getProperty("java.home"), "lib", "security", "cacerts");
    }

    private static char[] trustStorePassword() {
        String pw = System.getProperty("javax.net.ssl.trustStorePassword");
        return (pw == null || pw.isEmpty() ? "changeit" : pw).toCharArray();
    }

    private static boolean addToTrustStoreFile(X509Certificate cert) {
        Path store = trustStorePath();
        if (!Files.isReadable(store)) return false;
        try {
            char[] pw = trustStorePassword();
            KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
            try (InputStream in = Files.newInputStream(store)) {
                ks.load(in, pw);
            }
            Certificate existing = ks.getCertificate(ALIAS);
            if (existing != null && existing.equals(cert)) {
                return true; // already trusted, identical cert — idempotent no-op
            }
            if (!Files.isWritable(store)) {
                LOGGER.warn("[Figura Ely] JVM truststore {} is read-only — using in-memory fallback.", store);
                return false;
            }
            ks.setCertificateEntry(ALIAS, cert); // add, or replace a rotated cert
            Path tmp = store.resolveSibling(store.getFileName() + ".figura-ely.tmp");
            try (var out = Files.newOutputStream(tmp)) {
                ks.store(out, pw);
            }
            Files.move(tmp, store, StandardCopyOption.REPLACE_EXISTING);
            return true;
        } catch (Throwable t) {
            LOGGER.debug("[Figura Ely] Could not update truststore file {}: {}", store, t.toString());
            return false;
        }
    }

    private static boolean installDefaultSslContext(X509Certificate cert) {
        try {
            X509TrustManager systemTm = defaultTrustManager((KeyStore) null);

            KeyStore ours = KeyStore.getInstance(KeyStore.getDefaultType());
            ours.load(null, null);
            ours.setCertificateEntry(ALIAS, cert);
            X509TrustManager ourTm = defaultTrustManager(ours);

            if (systemTm == null || ourTm == null) return false;

            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new TrustManager[]{ new CompositeTrustManager(systemTm, ourTm) }, null);
            SSLContext.setDefault(ctx);
            HttpsURLConnection.setDefaultSSLSocketFactory(ctx.getSocketFactory());
            return true;
        } catch (Throwable t) {
            LOGGER.debug("[Figura Ely] Could not install default SSLContext: {}", t.toString());
            return false;
        }
    }

    private static X509TrustManager defaultTrustManager(KeyStore ks) throws Exception {
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(ks);
        for (TrustManager tm : tmf.getTrustManagers()) {
            if (tm instanceof X509TrustManager x) return x;
        }
        return null;
    }

    /** Accepts a chain if either the system trust or our extra cert accepts it. */
    private static final class CompositeTrustManager implements X509TrustManager {
        private final X509TrustManager system;
        private final X509TrustManager extra;

        CompositeTrustManager(X509TrustManager system, X509TrustManager extra) {
            this.system = system;
            this.extra = extra;
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            try {
                system.checkClientTrusted(chain, authType);
            } catch (CertificateException e) {
                extra.checkClientTrusted(chain, authType);
            }
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            try {
                system.checkServerTrusted(chain, authType);
            } catch (CertificateException e) {
                extra.checkServerTrusted(chain, authType);
            }
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            List<X509Certificate> all = new ArrayList<>();
            Collections.addAll(all, system.getAcceptedIssuers());
            Collections.addAll(all, extra.getAcceptedIssuers());
            return all.toArray(new X509Certificate[0]);
        }
    }
}
