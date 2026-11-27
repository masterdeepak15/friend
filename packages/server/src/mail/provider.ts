import type { MailMessage } from "@friend/protocol";
import type { MailCursor } from "./types";

/** The mailbox refused the login (a wrong or revoked password): nothing is retried until the owner changes it. */
export class MailAuthError extends Error {
  readonly kind = "auth";
}
/** The mail server could not be reached or failed: tried again later. */
export class MailNetworkError extends Error {
  readonly kind = "network";
}

export interface OutgoingMail {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  /** Mail written by the assistant without a person typing it says so, so other robots do not answer it. */
  autoSubmitted?: boolean;
}

export interface FetchResult {
  messages: MailMessage[];
  cursor: MailCursor;
  /** The first look at a mailbox, or the server renumbered it: the mail is kept for reading but is not news and starts nothing. */
  backfill: boolean;
}

/** What every kind of mailbox can do. The assistant never needs to know which kind it is talking to. */
export interface MailProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  fetchSince(cursor: MailCursor | null, limit: number): Promise<FetchResult>;
  getMessage(providerId: string): Promise<MailMessage | null>;
  search(query: string, limit: number): Promise<MailMessage[]>;
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
  markRead(providerId: string): Promise<void>;
  archive(providerId: string): Promise<void>;
  /** Calls the handler when something new may have arrived. Returns a function that stops it. */
  onNew(handler: () => void): () => void;
}
