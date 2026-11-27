import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Helper, type ChildLike } from "./helper";
import { HELPER_PS1 } from "./helperScript.gen";

/** A helper process that answers when told to. */
class FakeChild implements ChildLike {
  written: Record<string, unknown>[] = [];
  private line: (l: string) => void = () => {};
  private exit: () => void = () => {};
  killed = false;
  write(l: string): void {
    this.written.push(JSON.parse(l) as Record<string, unknown>);
  }
  onLine(cb: (l: string) => void): void {
    this.line = cb;
  }
  onExit(cb: () => void): void {
    this.exit = cb;
  }
  kill(): void {
    this.killed = true;
    queueMicrotask(this.exit);
  }
  say(m: object): void {
    this.line(JSON.stringify(m));
  }
  die(): void {
    this.exit();
  }
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function rig(timeoutMs = 1000) {
  const children: FakeChild[] = [];
  const events: [string, Record<string, unknown>][] = [];
  const helper = new Helper({
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    timeoutMs,
    onEvent: (e, d) => events.push([e, d]),
  });
  return { helper, children, events };
}

describe("the Windows helper", () => {
  it("waits until the helper says it is ready, then sends the call and gives back the text and the picture", async () => {
    const r = rig();
    const p = r.helper.call("snapshot", { vision: true });
    await flush();
    expect(r.children[0]!.written).toHaveLength(0); // not before it is ready
    r.children[0]!.say({ event: "ready" });
    await flush();
    expect(r.children[0]!.written[0]).toMatchObject({ op: "snapshot", args: { vision: true } });
    const id = r.children[0]!.written[0]!.id;
    r.children[0]!.say({ id, ok: true, result: { text: "3 elements", image: { mime: "image/png", data: "AAAA", scale: 0.5 } } });
    expect(await p).toEqual({ text: "3 elements", image: { mime: "image/png", data: "AAAA", scale: 0.5 } });
  });

  it("matches answers to calls by number, even out of order, and passes errors up as errors", async () => {
    const r = rig();
    const a = r.helper.call("click", { label: 1 });
    const b = r.helper.call("type", { text: "x" });
    await flush();
    r.children[0]!.say({ event: "ready" });
    await flush();
    const [ia, ib] = r.children[0]!.written.map((w) => w.id);
    r.children[0]!.say({ id: ib, ok: false, error: "The text did not arrive" });
    r.children[0]!.say({ id: ia, ok: true, result: { text: "clicked" } });
    expect(await a).toEqual({ text: "clicked" });
    await expect(b).rejects.toThrow("The text did not arrive");
  });

  it("passes on what the helper reports by itself, and ignores lines that are not JSON", async () => {
    const r = rig();
    const p = r.helper.call("ping");
    await flush();
    r.children[0]!.say({ event: "ready" });
    r.children[0]!.say({ event: "human" });
    r.children[0]!.say({ event: "hotkey" });
    (r.children[0] as unknown as { line: (l: string) => void }).line("WARNING: something from PowerShell");
    await flush();
    r.children[0]!.say({ id: r.children[0]!.written[0]!.id, ok: true, result: { text: "pong" } });
    await p;
    expect(r.events.map((e) => e[0])).toEqual(["human", "hotkey"]);
  });

  it("restarts the helper when a call takes too long, and fails the calls that were waiting", async () => {
    const r = rig(30);
    const p = r.helper.call("snapshot");
    await flush();
    r.children[0]!.say({ event: "ready" });
    await expect(p).rejects.toThrow(/did not answer snapshot/);
    expect(r.children[0]!.killed).toBe(true);
    const again = r.helper.call("ping");
    await flush();
    expect(r.children).toHaveLength(2); // a fresh helper
    r.children[1]!.say({ event: "ready" });
    await flush();
    r.children[1]!.say({ id: r.children[1]!.written[0]!.id, ok: true, result: { text: "pong" } });
    expect(await again).toEqual({ text: "pong" });
  });

  it("fails every waiting call when the helper dies, and starts again on the next call", async () => {
    const r = rig();
    const p = r.helper.call("snapshot");
    await flush();
    r.children[0]!.say({ event: "ready" });
    await flush();
    r.children[0]!.die();
    await expect(p).rejects.toThrow(/stopped/);
    const next = r.helper.call("ping");
    await flush();
    expect(r.children).toHaveLength(2);
    r.helper.stop();
    await expect(next).rejects.toThrow();
    await expect(r.helper.call("ping")).rejects.toThrow(/stopped/);
  });

  it("carries the script that is in helper/helper.ps1, so the one-file agent has the same helper", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(HELPER_PS1).toBe(readFileSync(join(here, "..", "helper", "helper.ps1"), "utf8").replace(/\r\n/g, "\n"));
  });
});
