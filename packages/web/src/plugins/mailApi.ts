export type SendKind = "send" | "reply" | "forward";
export type Ladder = Record<SendKind, "ask" | "auto">;

export interface MailAccountView {
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
  status: "new" | "online" | "needs-sign-in" | "error";
  statusDetail: string;
  hasPassword: boolean;
}

/** What the owner types for a mailbox. The password is write-only: it goes in and never comes back. */
export interface MailAccountInput {
  name: string;
  address: string;
  username: string;
  imap: MailAccountView["imap"];
  smtp: MailAccountView["smtp"];
  owners: string[];
  systems: string[];
}

/** Who handles a mailbox: the assistant (no route) or a crew worker. */
export interface Handlers {
  workers: { id: string; name: string; role: string }[];
  routes: { kind: "mail" | "meeting"; key: string; worker: string }[];
}

export interface MailApi {
  /** Who can handle a mailbox, and who does now. Without it (a screen without the crew) the choice is not shown. */
  handlers?(): Promise<Handlers>;
  setHandler?(accountId: number, worker: string | null): Promise<void>;
  list(): Promise<MailAccountView[]>;
  add(input: MailAccountInput, password: string, pin: string): Promise<MailAccountView>;
  update(id: number, input: Partial<MailAccountInput> & { enabled?: boolean }, password: string | undefined, pin: string): Promise<MailAccountView>;
  setLadder(id: number, ladder: Ladder, pin: string): Promise<MailAccountView>;
  test(id: number): Promise<{ ok: boolean; error?: string }>;
  remove(id: number, pin: string): Promise<void>;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}) } });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `That did not work (${res.status}).`);
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const httpMailApi: MailApi = {
  list: async () => (await call<{ accounts: MailAccountView[] }>("/api/mail/accounts")).accounts,
  add: async (input, password, pin) => (await call<{ account: MailAccountView }>("/api/mail/accounts", json("POST", { ...input, password, pin }))).account,
  update: async (id, input, password, pin) => (await call<{ account: MailAccountView }>(`/api/mail/accounts/${id}`, json("PATCH", { ...input, ...(password ? { password } : {}), pin }))).account,
  setLadder: async (id, ladder, pin) => (await call<{ account: MailAccountView }>(`/api/mail/accounts/${id}/ladder`, json("PUT", { ladder, pin }))).account,
  test: (id) => call(`/api/mail/accounts/${id}/test`, json("POST", {})),
  handlers: () => call<Handlers>("/api/crew/routes"),
  setHandler: async (id, worker) => void (await call("/api/crew/routes", json("PUT", { kind: "mail", key: String(id), worker }))),
  remove: async (id, pin) => void (await call(`/api/mail/accounts/${id}`, json("DELETE", { pin }))),
};
