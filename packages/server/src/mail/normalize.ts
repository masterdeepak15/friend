import type { MailAddress, MailMessage } from "@friend/protocol";
import type { AddressObject, ParsedMail } from "mailparser";

const KEEP = ["authentication-results", "list-unsubscribe", "list-id", "precedence", "auto-submitted", "message-id", "in-reply-to", "references", "x-failed-recipients"];

const addresses = (a: AddressObject | AddressObject[] | undefined): MailAddress[] => {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.flatMap((o) => o.value).flatMap((v) => (v.address ? [{ ...(v.name ? { name: v.name } : {}), address: v.address.toLowerCase() }] : []));
};

const plain = (html: string): string =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * A parsed email as Friend keeps it. Only the first copy of each header counts: the receiving server adds its own
 * Authentication-Results on top, and a copy the sender wrote sits lower down and must never be believed.
 */
export function normalizeMail(parsed: ParsedMail, accountId: number, providerId: string): MailMessage {
  const headers: Record<string, string> = {};
  for (const line of parsed.headerLines ?? []) {
    const key = line.key.toLowerCase();
    if (!KEEP.includes(key) || key in headers) continue;
    headers[key] = line.line.slice(line.line.indexOf(":") + 1).replace(/\r?\n\s+/g, " ").trim();
  }
  const first = (parsed.from?.value ?? [])[0];
  const refs = (headers.references ?? "").split(/\s+/).filter(Boolean);
  return {
    id: "",
    accountId,
    providerId,
    threadId: refs[0] ?? headers["in-reply-to"] ?? headers["message-id"] ?? providerId,
    from: { ...(first?.name ? { name: first.name } : {}), address: (first?.address ?? "").toLowerCase() },
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: (parsed.subject ?? "").slice(0, 500),
    date: parsed.date ? parsed.date.getTime() : Date.now(),
    text: (parsed.text ?? (typeof parsed.html === "string" ? plain(parsed.html) : "")).slice(0, 200_000),
    headers,
    attachments: (parsed.attachments ?? []).map((a) => ({ name: a.filename ?? "attachment", type: a.contentType, size: a.size })),
  };
}
