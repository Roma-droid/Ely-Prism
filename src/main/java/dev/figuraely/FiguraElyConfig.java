package dev.figuraely;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Simple JSON config stored at {@code config/figura-ely.json}.
 *
 * <pre>
 * {
 *   "enabled": true,
 *   "backendHost": "192.168.0.108:4000"
 * }
 * </pre>
 *
 * {@code backendHost} may include a port, e.g. {@code "figura.example.com:8443"}.
 */
public class FiguraElyConfig {

    public boolean enabled = true;
    // Default points at the public Figura Ely backend (Caddy terminates TLS on
    // 443, so no port is given). Change it in config/figura-ely.json for a
    // different host. A "host:port" form is allowed for a direct-port backend.
    public String backendHost = "ai.bobef.ru";

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    public static Path path() {
        return FabricLoader.getInstance().getConfigDir().resolve("figura-ely.json");
    }

    public static FiguraElyConfig load() {
        Path path = path();
        try {
            if (Files.exists(path)) {
                FiguraElyConfig cfg = GSON.fromJson(Files.readString(path), FiguraElyConfig.class);
                if (cfg != null) {
                    return cfg;
                }
            }
        } catch (Exception e) {
            FiguraElyMod.LOGGER.error("[Figura Ely] Could not read config, using defaults", e);
        }
        FiguraElyConfig def = new FiguraElyConfig();
        def.save();
        return def;
    }

    public void save() {
        Path path = path();
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, GSON.toJson(this));
        } catch (IOException e) {
            FiguraElyMod.LOGGER.error("[Figura Ely] Could not write config", e);
        }
    }
}
