import { describe, expect, it, vi } from "vitest";
import { arcPath, buildCategories, caption, fan, layoutArcs, menuReducer, polar, type MenuState } from "./radialModel";

const base = { muted: false, onToggleMute: () => {}, onSignedOut: () => {} };
const helpers = () => ({ logout: vi.fn(), lock: vi.fn(), classic: vi.fn() });
const ids = (cats: ReturnType<typeof buildCategories>) => cats.map((c) => c.id);
const items = (cats: ReturnType<typeof buildCategories>, id: string) => cats.find((c) => c.id === id)!.items.map((i) => i.id);

describe("the arcs", () => {
  it("polar points start at the top and go clockwise", () => {
    const top = polar(100, 100, 50, 0);
    expect([Math.round(top.x), Math.round(top.y)]).toEqual([100, 50]);
    const right = polar(100, 100, 50, 90);
    expect([Math.round(right.x), Math.round(right.y)]).toEqual([150, 100]);
    const down = polar(100, 100, 50, 180);
    expect([Math.round(down.x), Math.round(down.y)]).toEqual([100, 150]);
  });

  it("a ring of five is five equal arcs with small gaps, the first centred on the top", () => {
    const arcs = layoutArcs(5, 4);
    expect(arcs).toHaveLength(5);
    expect(arcs[0]!.mid).toBeCloseTo(0, 5);
    expect(arcs.map((a) => Math.round(a.end - a.start))).toEqual([68, 68, 68, 68, 68]); // 72 each minus the gap
    expect(arcs[1]!.start - arcs[0]!.end).toBeCloseTo(4, 5);
  });

  it("a fan is centred on its parent, and never wraps all the way round", () => {
    const f = fan(90, 3);
    expect(f.map((a) => a.mid)).toEqual([expect.closeTo(90 - 39, 5), expect.closeTo(90, 5), expect.closeTo(90 + 39, 5)]);
    const wide = fan(0, 12);
    const span = wide.at(-1)!.end - wide[0]!.start;
    expect(span).toBeLessThanOrEqual(330 + 1e-6);
  });

  it("builds a closed annular path, and flags a long arc", () => {
    const d = arcPath(0, 0, 40, 80, 0, 60);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toMatch(/A 80 80 0 0 1/);
    expect(arcPath(0, 0, 40, 80, 0, 200)).toMatch(/A 80 80 0 1 1/);
  });
});

describe("what the menu offers", () => {
  it("lists only what this Friend can really do, in five rings", () => {
    const cats = buildCategories(
      {
        ...base,
        voiceAvailable: true,
        voiceEnrolled: true,
        onEnroll: () => {},
        onHousehold: () => {},
        onToggleHandsFree: () => {},
        onToggleCamera: () => {},
        onToggleChat: () => {},
        onToggleTasks: () => {},
        onToggleMusic: () => {},
        onToggleLauncher: () => {},
        view: "companion",
        onView: () => {},
        onSettings: () => {},
        onPlugins: () => {},
        onConnectors: () => {},
      },
      helpers(),
    );
    expect(ids(cats)).toEqual(["voice", "screen", "settings", "connect", "account"]);
    expect(items(cats, "voice")).toEqual(["voice.handsfree", "voice.enroll", "voice.family", "voice.mute"]);
    expect(items(cats, "screen")).toEqual(["screen.camera", "screen.chat", "screen.tasks", "screen.music", "screen.launcher", "screen.view"]);
    expect(items(cats, "settings")).toEqual(["settings.model", "settings.voice", "settings.look", "settings.approvals", "settings.trading", "settings.widgets", "settings.system", "settings.security"]);
    expect(items(cats, "connect")).toEqual(["connect.plugins", "connect.connectors"]);
    expect(items(cats, "account")).toEqual(["account.classic", "account.logout", "account.lock"]);
  });

  it("leaves out what is not available, and a ring with nothing in it", () => {
    const cats = buildCategories({ ...base, voiceAvailable: false, onToggleHandsFree: () => {}, onEnroll: () => {} }, helpers());
    expect(items(cats, "voice")).toEqual(["voice.mute"]); // no speech: no hands-free, no enrolling
    expect(ids(cats)).toEqual(["voice", "account"]); // no screen switches, settings or connectors were given
  });

  it("offers family voices only after the owner has enrolled", () => {
    const h = { ...base, voiceAvailable: true, onEnroll: () => {}, onHousehold: () => {} };
    expect(items(buildCategories({ ...h, voiceEnrolled: false }, helpers()), "voice")).toEqual(["voice.enroll", "voice.mute"]);
    expect(items(buildCategories({ ...h, voiceEnrolled: true }, helpers()), "voice")).toEqual(["voice.enroll", "voice.family", "voice.mute"]);
  });

  it("shows which switches are on, and calls what was given", () => {
    const toggle = vi.fn();
    const mute = vi.fn();
    const cats = buildCategories({ ...base, muted: true, onToggleMute: mute, voiceAvailable: true, handsFreeOn: true, onToggleHandsFree: toggle }, helpers());
    const hands = cats.find((c) => c.id === "voice")!.items.find((i) => i.id === "voice.handsfree")!;
    expect(hands).toMatchObject({ kind: "toggle", on: true, label: "Hands-free" });
    hands.run();
    expect(toggle).toHaveBeenCalledTimes(1);
    const m = cats.find((c) => c.id === "voice")!.items.find((i) => i.id === "voice.mute")!;
    expect(m).toMatchObject({ kind: "toggle", on: true });
    m.run();
    expect(mute).toHaveBeenCalledTimes(1);
  });

  it("opens the settings on the tab that was chosen", () => {
    const onSettings = vi.fn();
    const cats = buildCategories({ ...base, onSettings }, helpers());
    cats.find((c) => c.id === "settings")!.items.find((i) => i.id === "settings.voice")!.run();
    expect(onSettings).toHaveBeenCalledWith("voice");
  });

  it("marks the dangerous ones, and shows the view being switched to", () => {
    const h = helpers();
    const onView = vi.fn();
    const cats = buildCategories({ ...base, view: "companion", onView }, h);
    const account = cats.find((c) => c.id === "account")!.items;
    expect(account.find((i) => i.id === "account.lock")).toMatchObject({ danger: true });
    expect(account.find((i) => i.id === "account.logout")!.danger).toBeFalsy();
    account.find((i) => i.id === "account.lock")!.run();
    expect(h.lock).toHaveBeenCalledTimes(1);
    const view = cats.find((c) => c.id === "screen")!.items.find((i) => i.id === "screen.view")!;
    expect(view.label).toBe("View: companion");
    view.run();
    expect(onView).toHaveBeenCalledWith("workspace");
  });
});

describe("opening and closing", () => {
  const closed: MenuState = { open: false, category: null, hover: null };
  it("opens and closes, forgetting where it was", () => {
    const o = menuReducer(closed, { type: "toggle" });
    expect(o).toEqual({ open: true, category: null, hover: null });
    const deep = menuReducer(menuReducer(o, { type: "category", id: "voice" }), { type: "hover", id: "voice.mute" });
    expect(deep).toEqual({ open: true, category: "voice", hover: "voice.mute" });
    expect(menuReducer(deep, { type: "toggle" })).toEqual(closed);
  });

  it("choosing the same ring again folds it back in", () => {
    const o = menuReducer(menuReducer(closed, { type: "open" }), { type: "category", id: "screen" });
    expect(menuReducer(o, { type: "category", id: "screen" }).category).toBeNull();
    expect(menuReducer(o, { type: "category", id: "voice" }).category).toBe("voice");
  });

  it("Esc steps back one level, then closes", () => {
    const o = menuReducer(menuReducer(closed, { type: "open" }), { type: "category", id: "screen" });
    const back = menuReducer(o, { type: "back" });
    expect(back).toEqual({ open: true, category: null, hover: null });
    expect(menuReducer(back, { type: "back" })).toEqual(closed);
  });

  it("Esc on a closed menu opens it", () => {
    expect(menuReducer(closed, { type: "escape" })).toEqual({ open: true, category: null, hover: null });
    const o = menuReducer(menuReducer(closed, { type: "open" }), { type: "category", id: "screen" });
    expect(menuReducer(o, { type: "escape" }).category).toBeNull();
  });

  it("does nothing to a closed menu it was told to hover", () => {
    expect(menuReducer(closed, { type: "hover", id: "voice" })).toEqual(closed);
  });
});

describe("the words in the middle of the orb", () => {
  const cats = buildCategories({ ...base, onSettings: () => {} }, helpers());
  const open: MenuState = { open: true, category: null, hover: null };
  const shut: MenuState = { open: false, category: null, hover: null };
  it("says MARK II when idle and SELECT when the menu is open", () => {
    expect(caption(shut, cats, "idle", false)).toBe("MARK II");
    expect(caption(open, cats, "idle", false)).toBe("SELECT");
  });
  it("names the open ring while nothing is under the pointer", () => {
    expect(caption({ ...open, category: "settings" }, cats, "idle", false)).toBe("SETTINGS");
  });
  it("names what is under the pointer, a ring or an item", () => {
    expect(caption({ ...open, hover: "settings" }, cats, "idle", false)).toBe("SETTINGS");
    expect(caption({ ...open, category: "settings", hover: "settings.voice" }, cats, "idle", false)).toBe("VOICE");
  });
  it("says LISTENING or BUSY when the assistant is active and the menu is not being used", () => {
    expect(caption(shut, cats, "listening", false)).toBe("LISTENING");
    expect(caption(shut, cats, "idle", true)).toBe("BUSY");
    expect(caption(open, cats, "listening", false)).toBe("SELECT");
  });
});
