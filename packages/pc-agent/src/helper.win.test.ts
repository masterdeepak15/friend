import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Helper, powershellSpawner } from "./helper";

/**
 * Runs against the real Windows desktop: it opens a small window of its own and types into it, so it takes over the mouse and keyboard
 * for a few seconds. It never touches another program's window. Only on Windows, and only when asked:
 *   FRIEND_PC_WIN_TEST=1 pnpm --filter @friend/pc-agent vitest run src/helper.win.test.ts
 */
const run = process.platform === "win32" && process.env.FRIEND_PC_WIN_TEST === "1";
const dir = mkdtempSync(join(tmpdir(), "friend-helper-"));
const helper = new Helper({ spawn: powershellSpawner(dir), timeoutMs: 60_000 });
let target: ChildProcess | null = null;
afterAll(() => {
  helper.stop();
  target?.kill();
});

const TITLE = "Friend helper test window";
/** A window that is ours: a form with one text box and one button. */
const FORM = `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form; $f.Text = '${TITLE}'; $f.Width = 520; $f.Height = 260; $f.StartPosition = 'CenterScreen'
$t = New-Object Windows.Forms.TextBox; $t.Left = 20; $t.Top = 30; $t.Width = 400; $t.Name = 'box'
$b = New-Object Windows.Forms.Button; $b.Text = 'Press me'; $b.Left = 20; $b.Top = 80; $b.Width = 120
$l = New-Object Windows.Forms.Label; $l.Left = 20; $l.Top = 130; $l.Width = 400; $l.Text = 'waiting'
$b.Add_Click({ $l.Text = 'button was pressed' })
$f.Controls.AddRange(@($t, $b, $l)); $f.TopMost = $true; [void]$f.ShowDialog()`;

describe.skipIf(!run)("the Windows helper on a real desktop", () => {
  it("answers, sees a display, and seals and unseals a secret", async () => {
    expect((await helper.call("ping")).text).toBe("pong");
    expect((await helper.call("displays")).text).toMatch(/\d+x\d+/);
    const sealed = (await helper.call("seal", { text: "a secret token" })).text;
    expect(sealed).not.toContain("secret");
    expect((await helper.call("unseal", { text: sealed })).text).toBe("a secret token");
  }, 90_000);

  it("finds a window of its own, clicks a button, types into a field and reads it back, then closes it", async () => {
    target = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", FORM], { windowsHide: false, stdio: "ignore" });
    await helper.call("wait_for", { condition: "window_active", window: TITLE, timeout: 20 }).catch(async () => {
      await helper.call("app", { action: "switch", name: TITLE });
    });
    const snap = await helper.call("snapshot", { vision: true, annotate: true });
    expect(snap.text).toContain(TITLE);
    expect(snap.image?.data.length ?? 0).toBeGreaterThan(1000);
    const find = (re: RegExp) => Number(snap.text.split("\n").find((l) => re.test(l))?.split(" | ")[0]);
    const box = find(/^\d+ \| Edit /);
    const button = find(/^\d+ \| Button \| Press me/);
    expect(Number.isFinite(box), "the text box in:\n" + snap.text.slice(0, 1200)).toBe(true);
    expect(Number.isFinite(button), "the button in:\n" + snap.text.slice(0, 1200)).toBe(true);

    await helper.call("click", { label: button });
    await helper.call("wait_for", { condition: "text_exists", text: "button was pressed", timeout: 8 });

    const typed = await helper.call("type", { label: box, text: "hello from Friend", clear: true });
    expect(typed.text).toMatch(/Typed 17 characters\. Checked/);
    await helper.call("app", { action: "close", name: TITLE });
  }, 120_000);
});
