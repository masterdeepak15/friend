import { describe, expect, it, vi } from "vitest";
import type { IO } from "../cli";
import { auditCommand } from "./audit";

const NOW = Date.UTC(2026, 10, 6, 12, 0);
function setup(responses: Record<string, { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }>, pin = "123456") {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const io: IO = { dataDir: "x", out: (l) => out.push(l), err: (l) => err.push(l), ask: vi.fn(async () => pin) };
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    const key = Object.keys(responses).find((k) => String(url).includes(k));
    if (!key) throw new Error(`unexpected ${String(url)}`);
    const r = responses[key]!;
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": r.text ? "text/plain" : "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  const written: { name: string; body: string }[] = [];
  const deps = { fetch: fetchFn, port: 8787, now: () => NOW, write: (name: string, body: string) => void written.push({ name, body }) };
  return { io, out, err, calls, deps, written };
}
const row = (over: Record<string, unknown> = {}) => ({ id: 1, ts: Date.UTC(2026, 10, 6, 9, 30), actorKind: "owner", actorId: "owner", requestId: "chat-1", parentId: null, kind: "request", target: "chat", outcome: "done", detail: { text: "hello" }, ...over });

describe("friend audit", () => {
  it("list asks for the PIN, sends it from this PC only, applies the filters, and prints one line per entry", async () => {
    const t = setup({ "/api/audit?": { json: { rows: [row(), row({ id: 2, kind: "tool.end", outcome: "refused", target: "fs.write" })], counts: { total: 2, refused: 1, failed: 0 } } } });
    const code = await auditCommand(["list", "--since", "2h", "--who", "dev", "--group", "approvals", "--result", "refused", "--q", "npm test", "--limit", "20"], t.io, t.deps);
    expect(code).toBe(0);
    expect(t.io.ask).toHaveBeenCalledWith(expect.stringMatching(/PIN/), { hidden: true });
    const url = new URL(t.calls[0]!.url);
    expect(url.origin).toBe("http://127.0.0.1:8787");
    expect(url.pathname).toBe("/api/audit");
    expect(Object.fromEntries(url.searchParams)).toEqual({ from: String(NOW - 2 * 3600_000), actorId: "dev", group: "approvals", outcome: "refused", q: "npm test", limit: "20" });
    expect((t.calls[0]!.init!.headers as Record<string, string>)["x-owner-pin"]).toBe("123456");
    expect(t.out.join("\n")).toContain("#1 2026-11-06 09:30:00 owner request chat");
    expect(t.out.join("\n")).toMatch(/#2 .*tool\.end fs\.write \[refused\]/);
    expect(t.out.at(-1)).toMatch(/2 entries, 1 refused, 0 failed/);
  });

  it("who maps a kind to the actor kind, and anything else to a name", async () => {
    const t = setup({ "/api/audit?": { json: { rows: [], counts: { total: 0, refused: 0, failed: 0 } } } });
    await auditCommand(["list", "--who", "worker"], t.io, t.deps);
    expect(new URL(t.calls[0]!.url).searchParams.get("actorKind")).toBe("worker");
  });

  it("show prints the tree of one request, indented, in order", async () => {
    const t = setup({ "/api/audit/request/chat-1": { json: { tree: [{ row: row({ id: 1 }), children: [] }, { row: row({ id: 3, kind: "tool.start", target: "office.assign" }), children: [{ row: row({ id: 5, kind: "worker.tool", actorKind: "worker", actorId: "Dev (be8d8dca)", target: "Bash" }), children: [] }] }] } } });
    expect(await auditCommand(["show", "chat-1"], t.io, t.deps)).toBe(0);
    const lines = t.out.filter((l) => l.includes("#"));
    expect(lines[0]).toMatch(/^#1 /);
    expect(lines[1]).toMatch(/^#3 /);
    expect(lines[2]).toMatch(/^ {2}#5 .*worker\.tool Bash/);
  });

  it("verify says OK, or names the broken entry and fails", async () => {
    const ok = setup({ "/api/audit/verify": { json: { ok: true, rows: 12, lastHash: "ab".repeat(32) } } });
    expect(await auditCommand(["verify"], ok.io, ok.deps)).toBe(0);
    expect(ok.out.join("\n")).toMatch(/OK \(12 rows\)/);
    const bad = setup({ "/api/audit/verify": { json: { ok: false, brokenAt: 7, reason: "hash" } } });
    expect(await auditCommand(["verify"], bad.io, bad.deps)).toBe(1);
    expect(bad.out.concat(bad.err).join("\n")).toMatch(/BROKEN at 7/);
  });

  it("verify --seal checks a seal against the log", async () => {
    const seal = `Friend audit seal 2026-11-06: rows 1-5, hash ${"ab".repeat(32)}`;
    const good = setup({ "/api/audit/verify-seal": { json: { ok: true } } });
    expect(await auditCommand(["verify", "--seal", seal], good.io, good.deps)).toBe(0);
    expect(good.calls[0]!.init!.method).toBe("POST");
    expect(JSON.parse(String(good.calls[0]!.init!.body))).toEqual({ text: seal });
    expect(good.out.join("\n")).toMatch(/Seal OK/);
    const bad = setup({ "/api/audit/verify-seal": { json: { ok: false, reason: "The log was rewritten." } } });
    expect(await auditCommand(["verify", "--seal", seal], bad.io, bad.deps)).toBe(1);
    expect(bad.out.concat(bad.err).join("\n")).toMatch(/does not match.*rewritten/);
  });

  it("export writes the file to the current folder and says where", async () => {
    const t = setup({ "/api/audit/export": { text: "<html>report</html>", headers: { "content-disposition": 'attachment; filename="friend-audit-2026-11-06.html"' } } });
    expect(await auditCommand(["export", "--format", "html", "--since", "7d"], t.io, t.deps)).toBe(0);
    const url = new URL(t.calls[0]!.url);
    expect(url.searchParams.get("format")).toBe("html");
    expect(url.searchParams.get("from")).toBe(String(NOW - 7 * 86_400_000));
    expect(t.written).toEqual([{ name: "friend-audit-2026-11-06.html", body: "<html>report</html>" }]);
    expect(t.out.join("\n")).toContain("friend-audit-2026-11-06.html");
  });

  it("export refuses a format it does not have, and a file name that is not plain", async () => {
    const bad = setup({});
    expect(await auditCommand(["export", "--format", "pdf"], bad.io, bad.deps)).toBe(1);
    const sneaky = setup({ "/api/audit/export": { text: "x", headers: { "content-disposition": 'attachment; filename="../../evil.sh"' } } });
    await auditCommand(["export", "--format", "csv"], sneaky.io, sneaky.deps);
    expect(sneaky.written.every((w) => !/[\\/]/.test(w.name))).toBe(true);
  });

  it("seal prints the current seal", async () => {
    const seal = `Friend audit seal 2026-11-06: rows 1-5, hash ${"ab".repeat(32)}`;
    const t = setup({ "/api/audit/seal": { json: { text: seal } } });
    expect(await auditCommand(["seal"], t.io, t.deps)).toBe(0);
    expect(t.out).toContain(seal);
  });

  it("control characters and escape codes in logged text never reach the terminal", async () => {
    const t = setup({ "/api/audit?": { json: { rows: [row({ target: "a\u001b[31mred\u001b[0m\u0007\u0000b", detail: { text: "\u001b]0;pwned\u0007x" } })], counts: { total: 1, refused: 0, failed: 0 } } } });
    await auditCommand(["list"], t.io, t.deps);
    const all = t.out.join("\n");
    expect(all).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(all).toContain("red");
  });

  it("says what the server said when the PIN is wrong, and that Friend is not running when it cannot be reached", async () => {
    const wrong = setup({ "/api/audit?": { status: 403, json: { error: "Incorrect PIN" } } });
    expect(await auditCommand(["list"], wrong.io, wrong.deps)).toBe(1);
    expect(wrong.err.join("\n")).toContain("Incorrect PIN");
    const down = setup({});
    expect(await auditCommand(["list"], down.io, { ...down.deps, fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch })).toBe(1);
    expect(down.err.join("\n")).toMatch(/not running/i);
  });

  it("an unknown subcommand, or a bad filter, prints the usage line", async () => {
    const t = setup({});
    expect(await auditCommand(["wipe"], t.io, t.deps)).toBe(1);
    expect(t.err.join("\n")).toMatch(/Usage: friend audit/);
    const bad = setup({});
    expect(await auditCommand(["list", "--since", "banana"], bad.io, bad.deps)).toBe(1);
    expect(await auditCommand([], bad.io, bad.deps)).toBe(1);
    expect(t.calls).toHaveLength(0);
  });
});

describe("minor hardening", () => {
  it("a newline or a bidi mark in a logged kind or target cannot fake another line", async () => {
    const row = { id: 1, ts: 0, actorKind: "owner", actorId: "owner", kind: "x\n#999 owner login", target: "a‮b\u009b", outcome: "", detail: {} };
    const t = setup({ "/api/audit": { json: { rows: [row], counts: { total: 1, refused: 0, failed: 0 } } } });
    await auditCommand(["list"], t.io, t.deps);
    const text = t.out.join("\n");
    expect(text.split("\n").filter((l) => l.startsWith("#"))).toHaveLength(1);
    expect(text).not.toMatch(/‮|\u009b/);
  });
});
