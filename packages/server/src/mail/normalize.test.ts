import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { normalizeMail } from "./normalize";

const raw = (extra: string[] = [], body = "Hello there") =>
  [
    "Authentication-Results: mx.corp.com; dkim=pass header.d=corp.com; spf=pass",
    "Authentication-Results: forged; dkim=pass header.d=evil.com",
    'From: "Ann Lee" <Ann@Corp.com>',
    "To: support@corp.com, Bob <bob@corp.com>",
    "Subject: Invoice question",
    "Message-ID: <abc@corp.com>",
    "Date: Mon, 02 Nov 2026 10:00:00 +0000",
    ...extra,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
  ].join("\r\n");

describe("a parsed email", () => {
  it("becomes a mail with lower-cased addresses, the receiving server's authentication result, and a thread", async () => {
    const m = normalizeMail(await simpleParser(raw()), 3, "5-9");
    expect(m).toMatchObject({ accountId: 3, providerId: "5-9", subject: "Invoice question", from: { name: "Ann Lee", address: "ann@corp.com" }, threadId: "<abc@corp.com>" });
    expect(m.to.map((a) => a.address)).toEqual(["support@corp.com", "bob@corp.com"]);
    expect(m.text).toContain("Hello there");
    expect(m.headers["authentication-results"]).toContain("header.d=corp.com");
    expect(m.headers["authentication-results"]).not.toContain("evil.com"); // only the topmost copy counts
  });

  it("threads on the first reference, and keeps the bulk-mail headers", async () => {
    const m = normalizeMail(await simpleParser(raw(["References: <root@x> <mid@x>", "In-Reply-To: <mid@x>", "List-Unsubscribe: <mailto:u@x>", "Precedence: bulk"])), 1, "1-1");
    expect(m.threadId).toBe("<root@x>");
    expect(m.headers).toMatchObject({ "list-unsubscribe": "<mailto:u@x>", precedence: "bulk" });
  });

  it("lists attachments without their content, and turns a mail with only html into text", async () => {
    const mime = ["From: a@x.com", "To: b@x.com", "Subject: s", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="B"', "", "--B", "Content-Type: text/html; charset=utf-8", "", "<p>Hi <b>there</b></p><script>x()</script>", "--B", 'Content-Type: application/pdf; name="inv.pdf"', 'Content-Disposition: attachment; filename="inv.pdf"', "Content-Transfer-Encoding: base64", "", "JVBERi0=", "--B--", ""].join("\r\n");
    const m = normalizeMail(await simpleParser(mime), 1, "1-2");
    expect(m.attachments).toEqual([{ name: "inv.pdf", type: "application/pdf", size: 5 }]);
    expect(m.text).toContain("Hi there");
    expect(m.text).not.toContain("x()");
  });
});
