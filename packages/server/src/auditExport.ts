import type { AuditRow, VerifyResult } from "./audit";
import { maskText, redactDetail } from "./auditRedact";

export type ExportFormat = "json" | "csv" | "html";
export interface ExportMeta {
  from: number | null;
  to: number | null;
  generatedAt: number;
  verify: VerifyResult;
}

const NOTICE = "This file contains private content from Friend's audit trail (commands, messages, file names). Keep it safe and share it only with someone you trust. Secrets are masked.";
const HTML_ROWS = 5000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();
const chainLine = (v: VerifyResult): string => (v.ok ? `Chain: OK (${v.rows} chained entries)` : `Chain: BROKEN at entry ${v.brokenAt} (${v.reason})`);

/** Masks again what was stored: an old entry, or a bug, may have let a secret through. */
function clean(row: AuditRow): AuditRow {
  const mask = (s: string) => maskText(s);
  return { ...row, actorId: mask(row.actorId), target: mask(row.target), detail: JSON.parse(redactDetail(row.detail).json) as Record<string, unknown> };
}

const esc = (s: unknown): string => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A CSV cell: quoted when it needs it, and a text that a spreadsheet would run as a formula gets a leading apostrophe. */
function cell(v: unknown): string {
  let s = String(v ?? "");
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: AuditRow[]): string {
  const head = "id,time,actorKind,actorId,requestId,parentId,kind,target,outcome,detail,prevHash,hash";
  const lines = rows.map((r) => [r.id, iso(r.ts), r.actorKind, r.actorId, r.requestId, r.parentId, r.kind, r.target, r.outcome, JSON.stringify(r.detail), r.prevHash, r.hash].map(cell).join(","));
  return [`# ${NOTICE}`, head, ...lines].join("\r\n") + "\r\n";
}

function toHtml(rows: AuditRow[], m: ExportMeta): string {
  const attention = rows.filter((r) => r.outcome === "refused" || r.outcome === "failed" || r.actorKind === "outsider");
  const line = (r: AuditRow) => `<tr><td>${r.id}</td><td>${esc(iso(r.ts))}</td><td>${esc(r.actorKind)} ${esc(r.actorId)}</td><td>${esc(r.kind)}</td><td>${esc(r.target)}</td><td>${esc(r.outcome)}</td><td><code>${esc(JSON.stringify(r.detail)).slice(0, 600)}</code></td></tr>`;
  const table = (list: AuditRow[]) => `<table><thead><tr><th>#</th><th>Time (UTC)</th><th>Who</th><th>What</th><th>Target</th><th>Result</th><th>Details</th></tr></thead><tbody>${list.map(line).join("")}</tbody></table>`;
  const range = m.from || m.to ? `${m.from ? day(m.from) : "the beginning"} to ${m.to ? day(m.to) : "now"}` : "everything kept";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Friend audit report</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#111}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}code{word-break:break-all}.note{background:#fff3cd;border:1px solid #e0c36a;padding:8px 12px}@media print{.note{border-color:#000}}</style></head><body><h1>Friend audit report</h1><p class="note">${esc(NOTICE)}</p><p>Range: ${esc(range)}. Made ${esc(iso(m.generatedAt))}.</p><p>${rows.length} entries, ${rows.filter((r) => r.outcome === "refused").length} refused, ${rows.filter((r) => r.outcome === "failed").length} failed. ${esc(chainLine(m.verify))}.</p><h2>Needs attention</h2>${attention.length ? table(attention.slice(0, 500)) : "<p>Nothing was refused or failed in this range.</p>"}<h2>Timeline</h2>${table(rows.slice(0, HTML_ROWS))}${rows.length > HTML_ROWS ? `<p>Only the first ${HTML_ROWS} entries are shown here; the JSON export has all ${rows.length}.</p>` : ""}</body></html>`;
}

/** The report as a file: JSON (with the chain fields, checkable elsewhere), CSV, or a printable HTML page. */
export function exportAudit(rows: AuditRow[], format: ExportFormat, meta: ExportMeta): { mime: string; filename: string; body: string } {
  const clear = rows.map(clean);
  const name = `friend-audit-${day(meta.generatedAt)}`;
  if (format === "json") return { mime: "application/json", filename: `${name}.json`, body: JSON.stringify({ notice: NOTICE, generatedAt: iso(meta.generatedAt), range: { from: meta.from, to: meta.to }, verify: meta.verify, rows: clear }, null, 2) };
  if (format === "csv") return { mime: "text/csv", filename: `${name}.csv`, body: toCsv(clear) };
  return { mime: "text/html", filename: `${name}.html`, body: toHtml(clear, meta) };
}
