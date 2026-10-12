import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig, sanitizeVideo } from "../config";
import { changeVideo, INTEGRATION_IDS, integrationSummary, integrationViews, isIntegrationId } from "../integrations";
import { applySettings, refuseForAgent, settingsView, SettingsError } from "../settings";

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "friend-videoset-"));
  return { dir, config: loadConfig(dir) };
};

describe("the video settings read back from the saved file", () => {
  it("start as the safe defaults: not installed, on the screen, 720 pixels, four hours, any public site, helpers found by themselves", () => {
    expect(fresh().config.video).toEqual({ installed: false, enabled: false, output: "screen", maxHeight: 720, maxMinutes: 240, allowedSites: [], ytdlp: "", ffmpeg: "", autoInstall: true });
  });
  it("keep every value inside its range and ignore what is not understood", () => {
    expect(sanitizeVideo({ installed: true, enabled: true, output: "host", maxHeight: 50, maxMinutes: 9999, allowedSites: ["YouTube.com", "bad name", "youtube.com"], ytdlp: "yt-dlp", ffmpeg: "C:/tools/ffmpeg.exe", autoInstall: false })).toEqual({
      installed: true,
      enabled: true,
      output: "host",
      maxHeight: 240,
      maxMinutes: 600,
      allowedSites: ["youtube.com"],
      ytdlp: "yt-dlp",
      ffmpeg: "C:/tools/ffmpeg.exe",
      autoInstall: false,
    });
    expect(sanitizeVideo({ output: "tv", maxHeight: "tall", maxMinutes: null, allowedSites: "all", ytdlp: 5, ffmpeg: "a b; rm -rf", autoInstall: "no" })).toEqual({ installed: false, enabled: false, output: "screen", maxHeight: 720, maxMinutes: 240, allowedSites: [], ytdlp: "", ffmpeg: "", autoInstall: true });
    expect(sanitizeVideo(undefined).installed).toBe(false);
  });
  it("survive a save", () => {
    const { dir, config } = fresh();
    config.video = { ...config.video, installed: true, output: "host", allowedSites: ["vimeo.com"] };
    saveConfig(config);
    expect(loadConfig(dir).video).toMatchObject({ installed: true, output: "host", allowedSites: ["vimeo.com"] });
  });
});

describe("changing them", () => {
  it("is the owner's, from the settings screen: where it plays, how sharp, how long, which sites, which helper programs", () => {
    const { config } = fresh();
    const applied = applySettings(config, { video: { output: "host", maxHeight: 480, maxMinutes: 90, allowedSites: ["YouTube.com", "https://vimeo.com/x"], ytdlp: "yt-dlp", ffmpeg: "ffmpeg", autoInstall: false } });
    expect(applied.changed).toContain("video.output");
    expect(config.video).toMatchObject({ output: "host", maxHeight: 480, maxMinutes: 90, allowedSites: ["youtube.com", "vimeo.com"], ytdlp: "yt-dlp", ffmpeg: "ffmpeg", autoInstall: false, installed: false, enabled: false });
  });
  it("never switches the plugin on or off (that is the plugins list, with the PIN)", () => {
    const { config } = fresh();
    expect(() => applySettings(config, { video: { enabled: true } })).toThrow(SettingsError);
    expect(() => applySettings(config, { video: { installed: true } })).toThrow(SettingsError);
    expect(config.video.enabled).toBe(false);
  });
  it("refuses a value out of range or a program name that is not one", () => {
    const { config } = fresh();
    for (const bad of [{ maxHeight: 5000 }, { maxHeight: 100 }, { maxMinutes: 0 }, { output: "tv" }, { ytdlp: "a b; rm -rf /" }, { ffmpeg: "x\u0000y" }, { allowedSites: Array.from({ length: 60 }, (_, i) => `s${i}.com`) }]) {
      expect(() => applySettings(config, { video: bad }), JSON.stringify(bad)).toThrow(SettingsError);
    }
    expect(config.video).toEqual(fresh().config.video);
  });
  it("is not for the assistant, even with the owner nearby: the program that gets started and the sites stay on the screen", () => {
    expect(() => refuseForAgent({ video: { output: "host" } })).toThrow(/only be changed by the owner/i);
    expect(() => refuseForAgent({ voice: { rate: 1 } })).not.toThrow();
  });
  it("is shown on the settings screen", () => {
    expect(settingsView(fresh().config).video).toEqual({ installed: false, enabled: false, output: "screen", maxHeight: 720, maxMinutes: 240, allowedSites: [], ytdlp: "", ffmpeg: "", autoInstall: true });
  });
});

describe("the video plugin in the plugins list", () => {
  const silent = { status: () => ({ telegram: { state: "off" as const }, twilio: { state: "off" as const } }) } as never;
  const found = { ytdlp: { found: true, version: "2026.10.01" }, ffmpeg: { found: true, version: "7.1" }, mpv: { found: true, version: "0.39" } };
  const status = (over: Record<string, unknown> = {}) => ({ status: () => ({ ...found, ...over }) });
  const view = (config: ReturnType<typeof fresh>["config"], s?: { status(): unknown }) => integrationViews(config, silent, undefined, undefined, undefined, undefined, undefined, undefined, s as never).find((v) => v.id === "video")!;

  it("is one of them, the last, and says what it needs", () => {
    expect(isIntegrationId("video")).toBe(true);
    expect(INTEGRATION_IDS[INTEGRATION_IDS.length - 1]).toBe("video");
    const v = view(fresh().config);
    expect(v).toMatchObject({ id: "video", name: "Web video", installed: false, state: "not-installed" });
    expect(v.description).toMatch(/yt-dlp/);
  });
  it("walks from missing helpers to ready", () => {
    const { config } = fresh();
    config.video.installed = true;
    expect(view(config, status({ ytdlp: { found: false } }))).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/yt-dlp/) });
    expect(view(config, status({ ffmpeg: { found: false } }))).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/ffmpeg/) }); // the screen needs it
    expect(view(config, status({ mpv: { found: false } }))).toMatchObject({ state: "off" }); // the screen does not need mpv
    expect(view(config, status())).toMatchObject({ state: "off", detail: "Switched off." });
    config.video.enabled = true;
    expect(view(config, status())).toMatchObject({ state: "online" });
    config.video.output = "host";
    expect(view(config, status({ mpv: { found: false } }))).toMatchObject({ state: "online", detail: expect.stringMatching(/browser window/i) }); // no mpv: a browser window is used
    expect(view(config, status({ mpv: { found: false }, ffmpeg: { found: false } }))).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/ffmpeg/) });
    expect(view(config, status({ ffmpeg: { found: false } }))).toMatchObject({ state: "online" }); // an mpv window does not need ffmpeg
  });
  it("says Friend is downloading the programs, and how far it is", () => {
    const { config } = fresh();
    config.video = { ...config.video, installed: true, enabled: true };
    const missing = { ytdlp: { found: false }, ffmpeg: { found: false } };
    expect(view(config, status({ ...missing, setup: { busy: true, message: "Downloading yt-dlp 42%…", error: null } }))).toMatchObject({ state: "connecting", detail: "Downloading yt-dlp 42%…" });
    expect(view(config, status({ ...missing, setup: { busy: true, message: null, error: null } })).state).toBe("connecting");
  });
  it("says Friend will download what is missing by itself, and shows why a download failed", () => {
    const { config } = fresh();
    config.video = { ...config.video, installed: true };
    const missing = { ytdlp: { found: false }, ffmpeg: { found: false } };
    expect(view(config, status({ ...missing, setup: { busy: false, message: null, error: null } }))).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/yt-dlp and ffmpeg.*download.*by itself/i) });
    expect(view(config, status({ ...missing, setup: { busy: false, message: null, error: "Friend could not download yt-dlp. Check the internet connection and try again." } }))).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/could not download yt-dlp/) });
  });
  it("asks for the programs by hand only when the owner turned the download off", () => {
    const { config } = fresh();
    config.video = { ...config.video, installed: true, autoInstall: false };
    expect(view(config, status({ ytdlp: { found: false, install: "yt-dlp is not installed. Install it once with: winget install yt-dlp." }, setup: { busy: false, message: null, error: null } }))).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/not found on this PC/) });
  });
  it("lists the steps and shows no setting the assistant could write", () => {
    const { config } = fresh();
    config.video = { ...config.video, installed: true, enabled: true };
    const v = view(config, status());
    expect(v.steps.map((s) => s.done)).toEqual([true, true, true]);
    expect(v.secrets).toEqual({});
  });
  it("is left out of the assistant's own list: only the owner decides it", () => {
    const { config } = fresh();
    config.video.installed = true;
    expect(integrationSummary(integrationViews(config, silent, undefined, undefined, undefined, undefined, undefined, undefined, status() as never))).not.toMatch(/Web video/);
  });
  it("changeVideo installs, switches on and off, and removes (forgetting the helper paths)", () => {
    const v = { ...fresh().config.video, ytdlp: "yt-dlp" };
    expect(changeVideo(v, { enabled: true })).toMatch(/not installed yet/);
    expect(changeVideo(v, { install: true })).toBeNull();
    expect(v.installed).toBe(true);
    expect(changeVideo(v, { enabled: true })).toBeNull();
    expect(v.enabled).toBe(true);
    expect(changeVideo(v, { enabled: false })).toBeNull();
    expect(changeVideo(v, { remove: true })).toBeNull();
    expect(v).toMatchObject({ installed: false, enabled: false, ytdlp: "", ffmpeg: "", output: "screen" });
  });
});
