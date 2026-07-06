package dev.figuraely;

import net.fabricmc.loader.api.entrypoint.PreLaunchEntrypoint;

/**
 * Runs before Minecraft bootstraps, which is the only point early enough to add
 * our backend certificate to the JVM's default trust before the first TLS
 * connection freezes the default {@code SSLContext}.
 *
 * <p>Deliberately touches no Minecraft classes (only {@link FiguraElyTrust},
 * which uses {@code java.security} + Fabric loader APIs) so it is safe here.
 */
public class FiguraElyPreLaunch implements PreLaunchEntrypoint {

    @Override
    public void onPreLaunch() {
        FiguraElyTrust.install();
    }
}
