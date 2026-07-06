package dev.figuraely;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.lang.reflect.Field;

/**
 * Figura Ely — a tiny client mod that redirects Figura to an Ely.by-compatible
 * backend.
 *
 * <p>Figura reads its backend address from the {@code Configs.SERVER_IP} config
 * value (default {@code figura.moonlight-devs.org}). We simply overwrite that
 * value with the host from our own config once the client has finished starting
 * up, then ask Figura to re-authenticate. Everything is done by reflection so
 * this mod does not need Figura on its compile classpath and keeps working
 * across Figura updates; if the internals ever change we log a clear message
 * telling the user to set {@code server_ip} manually.
 *
 * <p>The Ely.by session itself is provided by the launcher (ElyPrismLauncher /
 * authlib-injector), so Figura's {@code joinServer} call already authenticates
 * against Ely.by — this mod does not touch the game session.
 */
public class FiguraElyMod implements ClientModInitializer {

    public static final Logger LOGGER = LoggerFactory.getLogger("figura-ely");
    private static final String FIGURA_MOD_ID = "figura";

    private FiguraElyConfig config;

    @Override
    public void onInitializeClient() {
        config = FiguraElyConfig.load();
        ClientLifecycleEvents.CLIENT_STARTED.register(client -> applyBackend());
    }

    private void applyBackend() {
        if (!config.enabled) {
            LOGGER.info("[Figura Ely] Disabled in config — leaving Figura's backend unchanged.");
            return;
        }
        if (!FabricLoader.getInstance().isModLoaded(FIGURA_MOD_ID)) {
            LOGGER.warn("[Figura Ely] Figura is not installed — nothing to do.");
            return;
        }
        String host = config.backendHost;
        if (host == null || host.isBlank() || host.contains("example.com")) {
            LOGGER.warn("[Figura Ely] 'backendHost' is not configured in {} — "
                    + "edit it and restart, or set Figura's 'server_ip' manually.",
                    FiguraElyConfig.path());
            return;
        }
        try {
            applyToFigura(host.trim());
        } catch (Throwable t) {
            LOGGER.error("[Figura Ely] Could not set Figura's backend to '{}'. "
                    + "Set 'server_ip' to this value manually in Figura settings.", host, t);
        }
    }

    private void applyToFigura(String host) throws Exception {
        Class<?> configsClass = Class.forName("org.figuramc.figura.config.Configs");
        Object serverIp = configsClass.getField("SERVER_IP").get(null);

        Field valueField = findField(serverIp.getClass(), "value");
        valueField.setAccessible(true);

        Object current = valueField.get(serverIp);
        if (host.equals(current)) {
            LOGGER.info("[Figura Ely] Figura backend already points at '{}'.", host);
            return;
        }

        valueField.set(serverIp, host);
        LOGGER.info("[Figura Ely] Figura backend set to '{}' (was '{}').", host, current);

        // Trigger a re-auth against the new backend.
        if (!invokeQuietly(serverIp, "onChange")) {
            Class<?> networkStuff = Class.forName("org.figuramc.figura.backend2.NetworkStuff");
            networkStuff.getMethod("reAuth").invoke(null);
        }
    }

    private static boolean invokeQuietly(Object target, String method) {
        try {
            target.getClass().getMethod(method).invoke(target);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static Field findField(Class<?> type, String name) throws NoSuchFieldException {
        for (Class<?> k = type; k != null; k = k.getSuperclass()) {
            try {
                return k.getDeclaredField(name);
            } catch (NoSuchFieldException ignored) {
                // keep walking up the hierarchy
            }
        }
        throw new NoSuchFieldException(name);
    }
}
