export type ActorKind = "owner" | "assistant" | "worker" | "system" | "outsider";
export type KindGroup = "approvals" | "tools" | "workers" | "logins" | "messages" | "settings" | "system" | "other";
export type Outcome = "started" | "done" | "refused" | "failed" | "waiting";

export interface AuditRow {
  id: number;
  ts: number;
  actorKind: ActorKind;
  actorId: string;
  requestId: string | null;
  parentId: string | null;
  kind: string;
  target: string;
  outcome: Outcome | "";
  detail: Record<string, unknown>;
  legacy: boolean;
}
export interface AuditNode {
  row: AuditRow;
  children: AuditNode[];
}
export interface AuditFilter {
  from?: number;
  to?: number;
  actorKind?: ActorKind;
  actorId?: string;
  group?: KindGroup;
  outcome?: Outcome;
  q?: string;
  before?: number;
  limit?: number;
}
export type VerifyResult = { ok: true; rows: number; lastHash: string } | { ok: false; brokenAt: number; reason: string };
export interface AuditStatus {
  rows: number;
  lastId: number | null;
  lastSeal: { at: number; text: string | null } | null;
  keepDays: number;
  workers: { id: string; name: string; last: number }[];
}
export type ExportFormat = "json" | "csv" | "html";

/** The audit area is locked again (the unlock ran out, or Friend restarted): the PIN is asked for once more. */
export class AuditLocked extends Error {
  constructor() {
    super("The audit area is locked. Enter your PIN.");
  }
}

export interface AuditApi {
  /** Gives the PIN; the area stays open for the time set in Settings. */
  unlock(pin: string): Promise<void>;
  search(f: AuditFilter): Promise<{ rows: AuditRow[]; counts: { total: number; refused: number; failed: number } }>;
  tree(requestId: string): Promise<AuditNode[]>;
  attention(hours?: number): Promise<AuditRow[]>;
  verify(): Promise<VerifyResult>;
  status(): Promise<AuditStatus>;
  /** Saves a report of the range as a file. */
  download(f: AuditFilter, format: ExportFormat): Promise<void>;
}

const query = (f: Record<string, unknown>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** The unlock token lives only in memory: reloading the page asks for the PIN again. */
export function httpAuditApi(fetchFn: typeof fetch = fetch): AuditApi {
  let token: string | null = null;
  const call = async <T>(path: string, init: RequestInit = {}): Promise<Response & { body2?: T }> => {
    let res: Response;
    try {
      res = await fetchFn(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(token ? { "x-audit-unlock": token } : {}) } });
    } catch {
      throw new Error("Could not reach Friend. Check the connection.");
    }
    return res;
  };
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await call<T>(path, init);
    let body: { error?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* no JSON body */
    }
    if (res.status === 403 && body.error === "locked") {
      token = null;
      throw new AuditLocked();
    }
    if (!res.ok) throw new Error(body.error ?? (res.status === 401 ? "Please sign in again." : `The request failed (${res.status}).`));
    return body as T;
  };
  return {
    async unlock(pin) {
      const r = await json<{ token: string }>("/api/audit/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
      token = r.token;
    },
    search: (f) => json(`/api/audit${query(f as Record<string, unknown>)}`),
    tree: async (id) => (await json<{ tree: AuditNode[] }>(`/api/audit/request/${encodeURIComponent(id)}`)).tree,
    attention: async (hours = 24) => (await json<{ rows: AuditRow[] }>(`/api/audit/attention?hours=${hours}`)).rows,
    verify: () => json("/api/audit/verify"),
    status: () => json("/api/audit/status"),
    async download(f, format) {
      const res = await call(`/api/audit/export${query({ ...f, format })}`);
      if (res.status === 403) {
        token = null;
        throw new AuditLocked();
      }
      if (!res.ok) throw new Error(`The export failed (${res.status}).`);
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `friend-audit.${format}`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}
