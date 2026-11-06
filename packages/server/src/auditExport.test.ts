import { describe, expect, it } from "vitest";
import type { AuditRow } from "./audit";
import { exportAudit } from "./auditExport";

const H = "ab".repeat(32);
const row = (over: Partial<AuditRow> = {}): AuditRow => ({ id: 1, ts: Date.UTC(2026, 10, 6, 9, 30), actor: "owner", actorKind: "owner", actorId: "owner", requestId: "chat-1", parentId: null, kind: "request", target: "chat", outcome: "done", detail: { text: "hello" }, truncated: false, legacy: false, prevHash: "", hash: H, ...over });
const meta = { from: null, to: null, generatedAt: Date.UTC(2026, 10, 6, 12, 0), verify: { ok: true as const, rows: 3, lastHash: H } };

describe("exporting the trail", () => {
  it("JSON keeps the chain fields and parses back, under a note that it is private", () => {
    const out = exportAudit([row(), row({ id: 2, prevHash: H, hash: "cd".repeat(32), kind: "tool.end", outcome: "refused" })], "json", meta);
    expect(out.mime).toBe("application/json");
    expect(out.filename).toBe("friend-audit-2026-11-06.json");
    const j = JSON.parse(out.body) as { notice: string; verify: { ok: boolean }; rows: AuditRow[] };
    expect(j.notice).toMatch(/private/i);
    expect(j.verify).toMatchObject({ ok: true });
    expect(j.rows).toHaveLength(2);
    expect(j.rows[1]).toMatchObject({ prevHash: H, hash: "cd".repeat(32), outcome: "refused" });
  });

  it("CSV has a note, one header row, quotes commas, quotes and newlines, and defuses spreadsheet formulas", () => {
    const out = exportAudit([row({ target: 'a,b "c"\nd' }), row({ id: 2, target: "+1", actorId: "@x", kind: "-cmd" }), row({ id: 3, target: '=HYPERLINK("http://evil")' })], "csv", meta);
    expect(out.mime).toBe("text/csv");
    const lines = out.body.split("\r\n");
    expect(lines[0]).toMatch(/^# .*private/i);
    expect(lines[1]).toBe("id,time,actorKind,actorId,requestId,parentId,kind,target,outcome,detail,prevHash,hash");
    expect(out.body).toContain('"a,b ""c""\nd"');
    expect(out.body).not.toMatch(/(^|,)"?=HYPERLINK/m); // no cell starts with =
    expect(out.body).toContain("'=HYPERLINK");
    expect(out.body).toMatch(/,'\+1,/);
    expect(out.body).toMatch(/,'@x,/);
    expect(out.body).toMatch(/,'-cmd,/);
  });

  it("HTML names the range and totals, lists what needs attention, and escapes what was logged", () => {
    const evil = '<script>alert(1)</script> & "quotes"';
    const out = exportAudit([row({ detail: { text: evil } }), row({ id: 2, outcome: "refused", kind: "approval.decided", target: "<img src=x onerror=alert(1)>" }), row({ id: 3, outcome: "failed", kind: "tool.end" })], "html", { ...meta, from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 6) });
    expect(out.mime).toBe("text/html");
    expect(out.body).toMatch(/private/i);
    expect(out.body).toContain("2026-11-01");
    expect(out.body).toContain("2026-11-06");
    expect(out.body).toMatch(/3 entries/);
    expect(out.body).toMatch(/Needs attention/);
    expect(out.body).not.toContain("<script>");
    expect(out.body).not.toContain("<img");
    expect(out.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; ");
    expect(out.body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out.body).toContain("Content-Security-Policy");
    expect(out.body).toMatch(/Chain: (ok|OK)/);
  });

  it("masks a secret that got into stored text, in every format", () => {
    const rows = [row({ detail: { text: "token sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv here" }, target: "Bearer abcDEF123456xyz" })];
    for (const f of ["json", "csv", "html"] as const) {
      const out = exportAudit(rows, f, meta);
      expect(out.body, f).not.toMatch(/sk-ant-api03/);
      expect(out.body, f).not.toMatch(/abcDEF123456xyz/);
    }
  });

  it("keeps the chain's own fingerprints readable (they are what makes the export checkable)", () => {
    expect(exportAudit([row()], "json", meta).body).toContain(H);
    expect(exportAudit([row()], "csv", meta).body).toContain(H);
  });

  it("an empty range still gives a valid file, and a broken chain is said plainly", () => {
    expect(JSON.parse(exportAudit([], "json", meta).body).rows).toEqual([]);
    expect(exportAudit([], "csv", meta).body.split("\r\n")).toHaveLength(3); // note, header, and the end
    const html = exportAudit([row()], "html", { ...meta, verify: { ok: false, brokenAt: 7, reason: "hash" } }).body;
    expect(html).toMatch(/BROKEN at entry 7/);
  });
});
