import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, sanitizeHud, sanitizeMusic } from "../config";
import { applySettings, refuseForAgent, settingsView } from "../settings";

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "friend-hudsettings-"));
  return { dir, config: loadConfig(dir) };
};

describe("the defaults", () => {
  it("no music folder, the usual audio kinds, a quiet start, and a launcher with the panels", () => {
    const { config } = fresh();
    expect(config.music).toEqual({ folder: "", extensions: ["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac"], maxTracks: 5000, scanDepth: 6, volume: 70, shuffle: false, repeat: "all", visualizer: true, startView: "mini", defaultSource: "local", searchLimit: 10, output: "screen", hostPlayer: "", spotifyDevice: "", spotify: { installed: false, enabled: false, clientId: "" } });
    expect(config.hud).toMatchObject({ terminalLabel: "TERMINAL", clock: { hour12: true, seconds: false, locale: "" }, animations: "full" });
    expect(config.hud.launcher.map((l) => l.label)).toEqual(["Chat", "Tasks", "Music", "Plugins", "Settings"]);
  });
});

describe("what is read back from the saved file", () => {
  it("keeps every music value inside its range and drops kinds the browser cannot play", () => {
    const m = sanitizeMusic({ folder: 5, extensions: ["MP3", "wma", "ogg", "exe", "mp3"], maxTracks: 1, scanDepth: 99, volume: 500, shuffle: "yes", repeat: "forever", visualizer: 0, startView: "huge" });
    expect(m).toMatchObject({ folder: "", extensions: ["mp3", "ogg"], maxTracks: 100, scanDepth: 12, volume: 100, shuffle: false, repeat: "all", visualizer: true, startView: "mini" });
    expect(sanitizeMusic({ extensions: [] }).extensions).toContain("mp3");
  });

  it("keeps launcher buttons that are safe and drops the rest", () => {
    const h = sanitizeHud({
      terminalLabel: "x".repeat(60),
      animations: "wild",
      launcher: [
        { label: "Docs", icon: "📄", action: { type: "url", value: "https://example.com/docs" } },
        { label: "Evil", icon: "!", action: { type: "url", value: "javascript:alert(1)" } },
        { label: "Local", icon: "!", action: { type: "url", value: "file:///C:/Windows" } },
        { label: "Ask", icon: "?", action: { type: "prompt", value: "How is my portfolio?" } },
        { label: "Panel", icon: "P", action: { type: "panel", value: "plugins" } },
        { label: "Bad panel", icon: "P", action: { type: "panel", value: "everything" } },
        { label: "", icon: "P", action: { type: "panel", value: "chat" } },
        { label: "Play", icon: "▶", action: { type: "music", value: "toggle" } },
        5,
      ],
    });
    expect(h.launcher.map((l) => l.label)).toEqual(["Docs", "Ask", "Panel", "Play"]);
    expect(h.terminalLabel.length).toBeLessThanOrEqual(24);
    expect(h.animations).toBe("full");
    expect(new Set(h.launcher.map((l) => l.id)).size).toBe(h.launcher.length);
  });

  it("keeps at most twelve buttons", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `B${i}`, icon: "x", action: { type: "panel", value: "chat" } }));
    expect(sanitizeHud({ launcher: many }).launcher).toHaveLength(12);
  });
});

describe("music sources", () => {
  it("keeps the search limit and the default source inside their rules", () => {
    expect(sanitizeMusic({ searchLimit: 1 }).searchLimit).toBe(3);
    expect(sanitizeMusic({ searchLimit: 500 }).searchLimit).toBe(50);
    expect(sanitizeMusic({ searchLimit: "x" }).searchLimit).toBe(10);
    expect(sanitizeMusic({ defaultSource: "spotify" }).defaultSource).toBe("spotify");
    expect(sanitizeMusic({ defaultSource: "any" }).defaultSource).toBe("any");
    expect(sanitizeMusic({ defaultSource: "youtube" }).defaultSource).toBe("local");
  });

  it("reads the Spotify plugin entry: a client id is letters and digits only, the switches are real booleans", () => {
    expect(sanitizeMusic({ spotify: { installed: true, enabled: true, clientId: "  abc123DEF456ghi789  " } }).spotify).toEqual({ installed: true, enabled: true, clientId: "abc123DEF456ghi789" });
    expect(sanitizeMusic({ spotify: { installed: "yes", enabled: 1, clientId: "../etc/passwd" } }).spotify).toEqual({ installed: false, enabled: false, clientId: "" });
    expect(sanitizeMusic({ spotify: { clientId: "short" } }).spotify.clientId).toBe("");
    expect(sanitizeMusic({ spotify: { enabled: true } }).spotify.installed).toBe(true);
  });

  it("saves the default source and the search limit from the settings screen", () => {
    const { config } = fresh();
    applySettings(config, { music: { defaultSource: "any", searchLimit: 25 } });
    expect(config.music).toMatchObject({ defaultSource: "any", searchLimit: 25 });
    expect(() => applySettings(config, { music: { searchLimit: 2 } })).toThrow();
    expect(() => applySettings(config, { music: { defaultSource: "youtube" } })).toThrow();
  });

  it("never lets the settings screen or the assistant write the Spotify entry; it is changed only through the plugin", () => {
    const { config } = fresh();
    expect(() => applySettings(config, { music: { spotify: { installed: true, enabled: true, clientId: "abc123DEF456ghi789" } } })).toThrow();
    expect(config.music.spotify.clientId).toBe("");
    expect(() => refuseForAgent({ music: { defaultSource: "any" } })).toThrow(/only be changed by the owner/);
  });

  it("shows the Spotify client id, which is not secret, in the settings view", () => {
    const { config } = fresh();
    config.music.spotify.clientId = "abc123DEF456ghi789";
    expect(settingsView(config).music.spotify.clientId).toBe("abc123DEF456ghi789");
  });
});

describe("changing them from the screen", () => {
  it("saves music settings, when the folder exists", () => {
    const { config, dir } = fresh();
    const applied = applySettings(config, { music: { folder: dir, extensions: ["mp3", "flac"], maxTracks: 2000, scanDepth: 3, volume: 40, shuffle: true, repeat: "one", visualizer: false, startView: "full" } });
    expect(config.music).toMatchObject({ folder: dir, extensions: ["mp3", "flac"], maxTracks: 2000, scanDepth: 3, volume: 40, shuffle: true, repeat: "one", visualizer: false, startView: "full" });
    expect(applied.changed).toEqual(expect.arrayContaining(["music.folder", "music.volume"]));
    expect(settingsView(config).music.folder).toBe(dir);
  });

  it("refuses a folder that does not exist, or is a file, and a value outside its range", () => {
    const { config, dir } = fresh();
    const file = join(dir, "a-file.txt");
    writeFileSync(file, "x");
    expect(() => applySettings(config, { music: { folder: join(dir, "nope") } })).toThrow(/folder/i);
    expect(() => applySettings(config, { music: { folder: file } })).toThrow(/folder/i);
    for (const bad of [{ maxTracks: 50 }, { scanDepth: 0 }, { volume: 101 }, { extensions: ["wma"] }, { extensions: [] }, { repeat: "forever" }]) {
      expect(() => applySettings(config, { music: bad }), JSON.stringify(bad)).toThrow();
    }
    expect(config.music.folder).toBe("");
  });

  it("clears the folder with an empty value", () => {
    const { config, dir } = fresh();
    applySettings(config, { music: { folder: dir } });
    applySettings(config, { music: { folder: "" } });
    expect(config.music.folder).toBe("");
  });

  it("saves the widget settings and the launcher, and refuses a button that could run code", () => {
    const { config } = fresh();
    applySettings(config, { hud: { terminalLabel: "HOME BASE", clock: { hour12: false, seconds: true, locale: "en-GB" }, animations: "reduced", launcher: [{ label: "Mail", icon: "✉", action: { type: "url", value: "https://mail.example.com" } }] } });
    expect(config.hud).toMatchObject({ terminalLabel: "HOME BASE", clock: { hour12: false, seconds: true, locale: "en-GB" }, animations: "reduced" });
    expect(config.hud.launcher).toHaveLength(1);
    expect(() => applySettings(config, { hud: { launcher: [{ label: "x", icon: "x", action: { type: "url", value: "javascript:alert(1)" } }] } })).toThrow(/address/i);
    expect(() => applySettings(config, { hud: { clock: { locale: "not a locale!" } } })).toThrow();
    expect(() => applySettings(config, { hud: { launcher: Array.from({ length: 13 }, () => ({ label: "x", icon: "x", action: { type: "panel", value: "chat" } })) } })).toThrow();
    expect(config.hud.terminalLabel).toBe("HOME BASE");
  });

  it("is refused for the assistant, even with the PIN", () => {
    expect(() => refuseForAgent({ music: { folder: "C:\\" } })).toThrow(/only be changed by the owner/);
    expect(() => refuseForAgent({ hud: { launcher: [] } })).toThrow(/only be changed by the owner/);
  });
});

describe("where the sound comes out", () => {
  it("defaults to the screen, with the player and the Spotify device left for later", () => {
    const { config } = fresh();
    expect(config.music).toMatchObject({ output: "screen", hostPlayer: "", spotifyDevice: "" });
  });

  it("reads the saved values safely", () => {
    expect(sanitizeMusic({ output: "host" }).output).toBe("host");
    expect(sanitizeMusic({ output: "speaker" }).output).toBe("screen");
    expect(sanitizeMusic({ hostPlayer: "mpv" }).hostPlayer).toBe("mpv");
    expect(sanitizeMusic({ hostPlayer: "mpv --x" }).hostPlayer).toBe("");
    expect(sanitizeMusic({ hostPlayer: 5 }).hostPlayer).toBe("");
    expect(sanitizeMusic({ spotifyDevice: "  Living room  " }).spotifyDevice).toBe("Living room");
    expect(sanitizeMusic({ spotifyDevice: "x".repeat(300) }).spotifyDevice).toHaveLength(100);
  });

  it("saves them from the settings screen, and refuses a program with arguments", () => {
    const { config } = fresh();
    applySettings(config, { music: { output: "host", hostPlayer: "mpv", spotifyDevice: "Living room" } });
    expect(config.music).toMatchObject({ output: "host", hostPlayer: "mpv", spotifyDevice: "Living room" });
    expect(() => applySettings(config, { music: { hostPlayer: "mpv --no-video" } })).toThrow();
    expect(() => applySettings(config, { music: { output: "speaker" } })).toThrow();
    expect(config.music.hostPlayer).toBe("mpv");
  });

  it("is refused for the assistant", () => {
    expect(() => refuseForAgent({ music: { output: "host" } })).toThrow(/only be changed by the owner/);
  });
});
