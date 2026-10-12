import { describe, expect, it } from "vitest";
import { openInBrowser } from "./open";
import { fakeSpawn } from "./testing/fakeProcess";

const URL = `http://127.0.0.1:8787/api/video/${"a".repeat(32)}?o=${"b".repeat(32)}`;

describe("opening Friend's own video address in the PC's browser", () => {
  it("uses the system's own way on each system, without a shell for anything it was handed", async () => {
    const win = fakeSpawn();
    expect(await openInBrowser(URL, { spawn: win.spawn as never, platform: "win32" })).toBe(true);
    expect(win.calls[0]).toEqual({ cmd: "cmd", args: ["/c", "start", "", URL] });
    const mac = fakeSpawn();
    await openInBrowser(URL, { spawn: mac.spawn as never, platform: "darwin" });
    expect(mac.calls[0]).toEqual({ cmd: "open", args: [URL] });
    const lin = fakeSpawn();
    await openInBrowser(URL, { spawn: lin.spawn as never, platform: "linux" });
    expect(lin.calls[0]).toEqual({ cmd: "xdg-open", args: [URL] });
  });
  it("opens only Friend's own video address on this PC, whatever it is asked", async () => {
    const f = fakeSpawn();
    for (const bad of ["https://www.youtube.com/watch?v=x", "file:///C:/Windows/win.ini", "http://127.0.0.1:8787/api/music/x", `http://192.168.1.5:8787/api/video/${"a".repeat(32)}?o=${"b".repeat(32)}`, `${URL}&x=1`, `${URL}" & calc`, "calc.exe", ""]) {
      expect(await openInBrowser(bad, { spawn: f.spawn as never, platform: "win32" }), bad).toBe(false);
    }
    expect(f.calls).toEqual([]);
  });
  it("says it did not work when the system has no way to open a browser", async () => {
    const f = fakeSpawn();
    f.failToStart = true;
    expect(await openInBrowser(URL, { spawn: f.spawn as never, platform: "linux" })).toBe(false);
  });
  it("also takes Friend's secure address", async () => {
    const f = fakeSpawn();
    expect(await openInBrowser(URL.replace("http:", "https:"), { spawn: f.spawn as never, platform: "linux" })).toBe(true);
  });
});
