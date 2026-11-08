import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetsTab } from "./WidgetsTab";
import { diffSettings, type HudSettings, type MusicSettings, type SettingsView } from "./settingsApi";

afterEach(cleanup);

const music = { folder: "", extensions: ["mp3"], maxTracks: 5000, scanDepth: 6, volume: 70, shuffle: false, repeat: "all", visualizer: true, startView: "mini", defaultSource: "local", searchLimit: 10, output: "screen", hostPlayer: "", spotifyDevice: "", spotify: { installed: false, enabled: false, clientId: "" }, soundcloud: { installed: false, enabled: false, clientId: "" }, audius: { installed: false, enabled: false } } as MusicSettings;
const hud: HudSettings = { terminalLabel: "TERMINAL", clock: { hour12: true, seconds: false, locale: "" }, launcher: [], animations: "full", layout: "orbital", density: "standard", widgets: {}, tidy: { dockAfterSeconds: 40, maxChips: null, autoTidy: true } };

describe("the screen tidy knobs", () => {
  it("show the current values", () => {
    render(<WidgetsTab music={music} hud={hud} onMusic={() => {}} onHud={() => {}} />);
    expect((screen.getByLabelText(/put cards away after/i) as HTMLInputElement).value).toBe("40");
    expect((screen.getByLabelText(/most chips/i) as HTMLSelectElement).value).toBe("auto");
    expect((screen.getByLabelText(/tidy the screen by itself/i) as HTMLInputElement).checked).toBe(true);
  });
  it("send only what changed", () => {
    const onHud = vi.fn();
    render(<WidgetsTab music={music} hud={hud} onMusic={() => {}} onHud={onHud} />);
    fireEvent.change(screen.getByLabelText(/put cards away after/i), { target: { value: "90" } });
    expect(onHud).toHaveBeenLastCalledWith({ tidy: { dockAfterSeconds: 90, maxChips: null, autoTidy: true } });
    fireEvent.change(screen.getByLabelText(/most chips/i), { target: { value: "5" } });
    expect(onHud).toHaveBeenLastCalledWith({ tidy: { dockAfterSeconds: 40, maxChips: 5, autoTidy: true } });
    fireEvent.click(screen.getByLabelText(/tidy the screen by itself/i));
    expect(onHud).toHaveBeenLastCalledWith({ tidy: { dockAfterSeconds: 40, maxChips: null, autoTidy: false } });
  });
  it("work with a server that does not send them yet", () => {
    const { tidy: _t, ...old } = hud;
    render(<WidgetsTab music={music} hud={old} onMusic={() => {}} onHud={() => {}} />);
    expect((screen.getByLabelText(/put cards away after/i) as HTMLInputElement).value).toBe("40");
  });
  it("are saved as a small patch", () => {
    const view = (h: HudSettings) => ({ provider: "claude", model: "m", apiKeySet: false, view: "companion", music, hud: h, look: {}, ollama: {}, claudeCode: {}, voice: {} }) as unknown as SettingsView;
    const patch = diffSettings(view(hud), view({ ...hud, tidy: { dockAfterSeconds: 90, maxChips: 5, autoTidy: true } }), "");
    expect(patch.hud).toEqual({ tidy: { dockAfterSeconds: 90, maxChips: 5 } });
  });
});
