import { describe, expect, it } from "vitest";
import { DEBUG_FLAG, describeMains, hasFlag, isMainProcess, parseShortcutRows, patchArguments, shortcutScript } from "./src/browser.ts";

const MAIN = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory="Default"';
const MAIN_FLAGGED = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ${DEBUG_FLAG} --profile-directory="Default"`;
const HELPER = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --lang=en-US';

describe("is the banner flag on a command line", () => {
  it("finds it, and only the real flag", () => {
    expect(hasFlag(MAIN_FLAGGED)).toBe(true);
    expect(hasFlag(MAIN)).toBe(false);
    expect(hasFlag("chrome.exe --silent-debugger-extension-apix")).toBe(false);
    expect(hasFlag(`chrome.exe ${DEBUG_FLAG}=1`)).toBe(true);
  });
});

describe("which process is the browser itself", () => {
  it("is the one that is not a helper (renderer, gpu, utility ...)", () => {
    expect(isMainProcess(MAIN)).toBe(true);
    expect(isMainProcess(HELPER)).toBe(false);
  });
});

describe("what the running browser says about the banner", () => {
  it("says nothing is running when there is no browser", () => {
    expect(describeMains([])).toEqual({ running: false, hidden: null });
    expect(describeMains([HELPER])).toEqual({ running: false, hidden: null }); // helpers alone are not a browser
  });
  it("says the banner is hidden only when the browser was started with the flag", () => {
    expect(describeMains([MAIN_FLAGGED, HELPER])).toEqual({ running: true, hidden: true });
    expect(describeMains([MAIN, HELPER])).toEqual({ running: true, hidden: false });
  });
  it("says it is not hidden when any browser process lacks the flag", () => {
    expect(describeMains([MAIN_FLAGGED, MAIN])).toEqual({ running: true, hidden: false });
  });
});

describe("adding the flag to a shortcut's arguments", () => {
  it("adds it after what is there", () => {
    expect(patchArguments('--profile-directory="Default"')).toEqual({ args: `--profile-directory="Default" ${DEBUG_FLAG}`, changed: true });
    expect(patchArguments("")).toEqual({ args: DEBUG_FLAG, changed: true });
  });
  it("leaves a shortcut that has it alone", () => {
    expect(patchArguments(`${DEBUG_FLAG} --x`)).toEqual({ args: `${DEBUG_FLAG} --x`, changed: false });
  });
});

describe("the shortcut script", () => {
  it("looks only at shortcuts to Chrome, Edge and Brave in the places people start them from", () => {
    const s = shortcutScript(false);
    expect(s).toMatch(/chrome\|msedge\|brave/);
    for (const where of ["Desktop", "CommonDesktopDirectory", "Programs", "CommonPrograms", "TaskBar"]) expect(s).toContain(where);
  });
  it("only counts when told not to change anything, and saves only when told to", () => {
    expect(shortcutScript(false)).not.toMatch(/\.Save\(\)/);
    expect(shortcutScript(true)).toMatch(/\.Save\(\)/);
    expect(shortcutScript(true)).toContain(DEBUG_FLAG);
  });
});

describe("reading what the script printed", () => {
  it("counts patched, already set and failed, and how many have the flag now", () => {
    const out = ["patched|C:\\a.lnk", "already|C:\\b.lnk", "failed|C:\\c.lnk", "patched|C:\\d.lnk", ""].join("\n");
    expect(parseShortcutRows(out)).toEqual({ patched: 2, already: 1, failed: 1, withFlag: 3, total: 4 });
  });
  it("reads a count-only run", () => {
    expect(parseShortcutRows(["has|a", "none|b", "none|c"].join("\r\n"))).toEqual({ patched: 0, already: 0, failed: 0, withFlag: 1, total: 3 });
  });
  it("copes with nothing printed", () => {
    expect(parseShortcutRows("")).toEqual({ patched: 0, already: 0, failed: 0, withFlag: 0, total: 0 });
  });
});
