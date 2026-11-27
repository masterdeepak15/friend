import { NO_PC_PERMISSIONS } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Helper, powershellSpawner } from "./helper";
import { Terms } from "./term";

/** A real pseudo console on Windows. It uses no mouse, no keyboard and no screen, only its own terminal, so it is safe to run anywhere on Windows. */
const dir = mkdtempSync(join(tmpdir(), "friend-termwin-"));
let terms: Terms;
const helper = new Helper({ spawn: powershellSpawner(dir), timeoutMs: 60_000, onEvent: (e, d) => terms?.onEvent(e, d) });
terms = new Terms({ helper });
afterAll(async () => {
  await terms.closeAll();
  helper.stop();
});

describe.skipIf(process.platform !== "win32")("a terminal on a real pseudo console", () => {
  it("opens a shell, runs a command typed like a person, reads the screen, and closes it", async () => {
    const perms = { ...NO_PC_PERMISSIONS, shell: true, folders: [dir] };
    const opened = await terms.run("pc.term.open", { cwd: dir, command: "shell" }, perms, false);
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    const sent = await terms.run("pc.term.send", { id: "t1", text: "Write-Output ('hello-' + 'from-friend')", enter: true }, perms, false);
    expect(sent.ok).toBe(true);
    const waited = await terms.run("pc.term.wait", { id: "t1", until: "text", text: "hello-from-friend", timeout: 20 }, perms, false);
    expect(waited.ok && waited.output).toContain("hello-from-friend");
    const lines = (waited.ok ? waited.output : "").split("\n").filter((l) => l.includes("hello-from-friend"));
    expect(lines.some((l) => !l.includes("Write-Output"))).toBe(true); // the result, not only the echo of what was typed
    expect(await terms.run("pc.term.close", { id: "t1" }, perms, false)).toMatchObject({ ok: true });
  }, 120_000);
});
