import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HUD_WIDGET_IDS } from "@friend/protocol";
import { WidgetsTab } from "./WidgetsTab";
import { diffSettings, type HudSettings, type MusicSettings, type SettingsView } from "./settingsApi";

afterEach(cleanup);

const music = { folder: "", extensions: ["mp3"], maxTracks: 5000, scanDepth: 6, volume: 70, shuffle: false, repeat: "all", visualizer: true, startView: "mini", defaultSource: "local", searchLimit: 10, output: "screen", hostPlayer: "", spotifyDevice: "", spotify: { installed: false, enabled: false, clientId: "" }, soundcloud: { installed: false, enabled: false, clientId: "" }, audius: { installed: false, enabled: false } } as MusicSettings;
const classic: HudSettings = { terminalLabel: "TERMINAL", clock: { hour12: true, seconds: false, locale: "" }, launcher: [], animations: "full", layout: "classic", density: "standard", widgets: {} };
const orbital: HudSettings = { ...classic, layout: "orbital" };

describe("the screen layout section of the widgets settings", () => {
  it("chooses the layout", () => {
    const onHud = vi.fn();
    render(<WidgetsTab music={music} hud={classic} onMusic={() => {}} onHud={onHud} />);
    fireEvent.change(screen.getByLabelText(/screen layout/i), { target: { value: "orbital" } });
    expect(onHud).toHaveBeenCalledWith({ layout: "orbital" });
  });

  it("chooses the density", () => {
    const onHud = vi.fn();
    render(<WidgetsTab music={music} hud={orbital} onMusic={() => {}} onHud={onHud} />);
    fireEvent.change(screen.getByLabelText(/density/i), { target: { value: "calm" } });
    expect(onHud).toHaveBeenCalledWith({ density: "calm" });
  });

  it("has one box per widget; the live instruments are unticked until switched on, the others ticked unless switched off; it sends only the box that changed", () => {
    const onHud = vi.fn();
    render(<WidgetsTab music={music} hud={{ ...orbital, widgets: { radar: false, voice: true, budget: false } }} onMusic={() => {}} onHud={onHud} />);
    for (const id of HUD_WIDGET_IDS) expect(screen.getByTestId(`hud-widget-${id}`)).toBeTruthy();
    const checked = (id: string) => (screen.getByTestId(`hud-widget-${id}`) as HTMLInputElement).checked;
    expect(checked("radar")).toBe(false);
    expect(checked("system")).toBe(false); // brought up by Friend when asked
    expect(checked("voice")).toBe(true); // kept on the screen by the owner
    expect(checked("usage")).toBe(true);
    expect(checked("budget")).toBe(false);
    fireEvent.click(screen.getByTestId("hud-widget-radar"));
    expect(onHud).toHaveBeenCalledWith({ widgets: { radar: true, voice: true, budget: false } });
  });

  it("keeps the earlier switches when another box is toggled (the screen merges one level only)", () => {
    const onHud = vi.fn();
    render(<WidgetsTab music={music} hud={{ ...orbital, widgets: { radar: false } }} onMusic={() => {}} onHud={onHud} />);
    fireEvent.click(screen.getByTestId("hud-widget-feed"));
    expect(onHud).toHaveBeenCalledWith({ widgets: { radar: false, feed: true } });
    fireEvent.click(screen.getByTestId("hud-widget-usage"));
    expect(onHud).toHaveBeenLastCalledWith({ widgets: { radar: false, usage: false } });
  });

  it("has a switch for sample data that previews the look, off unless set", () => {
    const onHud = vi.fn();
    render(<WidgetsTab music={music} hud={orbital} onMusic={() => {}} onHud={onHud} />);
    const box = screen.getByTestId("hud-preview") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/sample data/i)).toBeTruthy();
    fireEvent.click(box);
    expect(onHud).toHaveBeenCalledWith({ preview: true });
  });

  it("leaves the widget boxes disabled while the layout is classic", () => {
    render(<WidgetsTab music={music} hud={classic} onMusic={() => {}} onHud={() => {}} />);
    expect((screen.getByTestId("hud-widget-radar") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/density/i) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId("hud-preview") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("saving the new screen settings", () => {
  const view = (hud: HudSettings) => ({ provider: "claude", model: "m", apiKeySet: false, view: "companion", music, hud, look: {}, ollama: {}, claudeCode: {}, voice: {} }) as unknown as SettingsView;

  it("sends the layout, the density and only the widgets that changed", () => {
    const before = view(orbital);
    const after = structuredClone(before);
    after.hud!.layout = "classic";
    after.hud!.density = "full";
    after.hud!.widgets = { radar: false };
    expect(diffSettings(before, after, "")).toEqual({ hud: { layout: "classic", density: "full", widgets: { radar: false } } });
  });

  it("sends the sample-data switch when it changed", () => {
    const before = view(orbital);
    const after = structuredClone(before);
    after.hud!.preview = true;
    expect(diffSettings(before, after, "")).toEqual({ hud: { preview: true } });
  });

  it("sends nothing when they did not change", () => {
    expect(diffSettings(view(orbital), view(structuredClone(orbital)), "")).toEqual({});
  });
});
