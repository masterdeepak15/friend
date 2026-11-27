import type { MailClass, MailMessage } from "@friend/protocol";

/** Where a mailbox's sync stopped: a new UIDVALIDITY means the server renumbered, and old numbers mean nothing. */
export interface MailCursor {
  uidValidity: number;
  lastUid: number;
}

export type SendKind = "send" | "reply" | "forward";
/** Per kind of send: `ask` the owner every time, or `auto` (still asked for a recipient this mailbox has not dealt with). */
export type Ladder = Record<SendKind, "ask" | "auto">;
export const DEFAULT_LADDER: Ladder = { send: "ask", reply: "ask", forward: "ask" };

export type MailStatus = "new" | "online" | "needs-sign-in" | "error";

export interface MailAccount {
  id: number;
  name: string;
  address: string;
  imap: { host: string; port: number; tls: boolean };
  smtp: { host: string; port: number; secure: boolean };
  username: string;
  owners: string[];
  systems: string[];
  ladder: Ladder;
  enabled: boolean;
  status: MailStatus;
  statusDetail: string;
  cursor: MailCursor | null;
  createdAt: number;
}

export interface StoredMail extends MailMessage {
  class: MailClass;
  read: boolean;
  archived: boolean;
}
