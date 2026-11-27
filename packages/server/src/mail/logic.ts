import type { MailMessage } from "@friend/protocol";

/** Fills {{name}} in a template. The values are text only: nothing in them is looked at again or run. Missing values are named. */
export function renderTemplate(t: { subject: string; text: string }, vars: Record<string, string>): { ok: true; subject: string; text: string } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const fill = (s: string): string =>
    s.replace(/\{\{\s*([A-Za-z0-9_.-]{1,40})\s*\}\}/g, (_m, name: string) => {
      if (name in vars) return vars[name]!;
      if (!missing.includes(name)) missing.push(name);
      return "";
    });
  const subject = fill(t.subject);
  const text = fill(t.text);
  return missing.length ? { ok: false, missing } : { ok: true, subject, text };
}

export interface RuleConditions {
  from?: string[];
  to?: string[];
  subjectContains?: string;
  subjectRegex?: string;
  hasAttachment?: boolean;
  attachmentType?: string;
  bodyContains?: string;
}

const addressMatches = (list: string[], address: string): boolean => {
  const a = address.toLowerCase();
  return list.some((e) => {
    const x = e.trim().toLowerCase();
    return x.startsWith("@") ? a.endsWith(x) : a === x;
  });
};

/** A pattern is tried only on a short subject and only if it has no nested repeat that could take forever. */
function safeRegex(src: string, text: string): boolean {
  if (src.length > 200 || /\([^)]*[+*][^)]*\)[+*{]/.test(src)) return false;
  try {
    return new RegExp(src, "i").test(text.slice(0, 500));
  } catch {
    return false;
  }
}

/** Every condition given must hold. A rule with none matches nothing, so a half-written rule can never catch all mail. */
export function matchRule(c: RuleConditions, m: MailMessage): boolean {
  let any = false;
  const need = (ok: boolean): boolean => ((any = true), ok);
  if (c.from?.length && !need(addressMatches(c.from, m.from.address))) return false;
  if (c.to?.length && !need([...m.to, ...m.cc].some((t) => addressMatches(c.to!, t.address)))) return false;
  if (c.subjectContains && !need(m.subject.toLowerCase().includes(c.subjectContains.toLowerCase()))) return false;
  if (c.subjectRegex && !need(safeRegex(c.subjectRegex, m.subject))) return false;
  if (c.bodyContains && !need(m.text.toLowerCase().includes(c.bodyContains.toLowerCase()))) return false;
  if (c.hasAttachment !== undefined && !need((m.attachments.length > 0) === c.hasAttachment)) return false;
  if (c.attachmentType && !need(m.attachments.some((a) => a.type.toLowerCase().includes(c.attachmentType!.toLowerCase()) || a.name.toLowerCase().endsWith(`.${c.attachmentType!.toLowerCase()}`)))) return false;
  return any;
}

export type ScheduleSpec = { kind: "daily"; at: string; lastRun: number } | { kind: "every"; minutes: number; lastRun: number };

/** Whether a schedule is due. A daily one fires once after its time each day, also late (a PC that was off), never twice. */
export function scheduleDue(s: ScheduleSpec, now: number): boolean {
  if (s.kind === "every") return s.minutes > 0 && now - s.lastRun >= s.minutes * 60_000;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.at);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return false;
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(m[1]), Number(m[2]), 0, 0).getTime();
  return now >= today && s.lastRun < today;
}
