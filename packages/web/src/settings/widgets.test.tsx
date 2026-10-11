import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WidgetsTab } from "./WidgetsTab";
import { diffSettings, type HudSettings, type MusicSettings, type SettingsView } from "./settingsApi";

const music: MusicSettings = { folder: "C:\Music", extensions: ["mp3", "flac"], maxTracks: 5000, scanDepth: 6, volume: 70, shuffle: false, repeat: "all", visualizer: true, startView: "mini", defaultSource: "local", searchLimit: 10, output: "screen", hostPlayer: "", spotifyDevice: "", spotify: { installed: false, enabled: false, clientId: "" } };
const hud: HudSettings = { terminalLabel: "TERMINAL", clock: { hour12: true, seconds: false, locale: "" }, launcher: [{ id: "a", label: "Chat", icon: "C", action: { type: "panel", value: "chat" } }], animations: "full" };
const base = { provider: "claude", model: "m", apiKeySet: false, view: "companion", music, hud, look: {}, ollama: {}, claudeCode: {}, voice: {} } as unknown as SettingsView;

describe("widgets settings", () => {
  it("sends only the music and widget fields that changed", () => {
    const after = structuredClone(base);
    after.music!.volume = 40;
    after.hud!.clock.seconds = true;
    after.hud!.launcher.push({ label: "Docs", icon: "D", action: { type: "url", value: "https://example.com" } });
    expect(diffSettings(base, after, "")).toEqual({ music: { volume: 40 }, hud: { clock: { seconds: true }, launcher: after.hud!.launcher } });
  });

  it("sends nothing when nothing changed", () => {
    expect(diffSettings(base, structuredClone(base), "")).toEqual({});
  });

  it("edits the folder and lists a bad address as a problem", () => {
    const onMusic = vi.fn();
    const onHud = vi.fn();
    render(<WidgetsTab music={music} hud={{ ...hud, launcher: [{ label: "Bad", icon: "B", action: { type: "url", value: "javascript:alert(1)" } }] }} onMusic={onMusic} onHud={onHud} />);
    fireEvent.change(screen.getByDisplayValue("C:\Music"), { target: { value: "D:\Songs" } });
    expect(onMusic).toHaveBeenCalledWith({ folder: "D:\Songs" });
    expect(screen.getByRole("alert").textContent).toMatch(/http/);
  });

  it("chooses the default source and the search limit", () => {
    const onMusic = vi.fn();
    render(<WidgetsTab music={music} hud={hud} onMusic={onMusic} onHud={() => {}} />);
    fireEvent.change(screen.getByDisplayValue("The music folder"), { target: { value: "any" } });
    expect(onMusic).toHaveBeenCalledWith({ defaultSource: "any" });
    fireEvent.change(screen.getByDisplayValue("10"), { target: { value: "25" } });
    expect(onMusic).toHaveBeenCalledWith({ searchLimit: 25 });
  });

  it("keeps at least one file type and caps the buttons", () => {
    const onMusic = vi.fn();
    const full = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, label: `B${i}`, icon: "x", action: { type: "panel" as const, value: "chat" } }));
    render(<WidgetsTab music={{ ...music, extensions: ["mp3"] }} hud={{ ...hud, launcher: full }} onMusic={onMusic} onHud={() => {}} />);
    fireEvent.click(screen.getByLabelText("mp3"));
    expect(onMusic).not.toHaveBeenCalled();
    expect((screen.getByText(/Add a button/) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("where the sound comes out", () => {
  it("chooses the output, the program and the Spotify device, and says what is wrong with a program", () => {
    const onMusic = vi.fn();
    const { rerender } = render(<WidgetsTab music={music} hud={hud} onMusic={onMusic} onHud={() => {}} />);
    fireEvent.change(screen.getByLabelText(/where the sound comes out/i), { target: { value: "host" } });
    expect(onMusic).toHaveBeenCalledWith({ output: "host" });
    fireEvent.change(screen.getByLabelText(/program that plays/i), { target: { value: "mpv" } });
    expect(onMusic).toHaveBeenCalledWith({ hostPlayer: "mpv" });
    fireEvent.change(screen.getByPlaceholderText(/name Spotify shows/i), { target: { value: "Living room" } });
    expect(onMusic).toHaveBeenCalledWith({ spotifyDevice: "Living room" });
    rerender(<WidgetsTab music={{ ...music, hostPlayer: "mpv --x" }} hud={hud} onMusic={onMusic} onHud={() => {}} />);
    expect(screen.getByText(/Arguments cannot be added/)).toBeTruthy();
  });
});
