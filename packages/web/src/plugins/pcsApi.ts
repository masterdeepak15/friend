import type { PcPermissions, PcStatus } from "@friend/protocol";

export interface PcView {
  id: number;
  name: string;
  os: string;
  host: string;
  online: boolean;
  permissions: PcPermissions;
  status: PcStatus | null;
  lastSeen: number;
  revoked: boolean;
  lease: { until: number | null; paused: boolean } | null;
}

export interface AddedPc {
  pc: PcView;
  enrollmentId: string;
  /** What the owner copies onto the new PC; null when this Friend has no agent file built. */
  install: { command: string; ps1Url: string; cmdUrl: string } | null;
  agentMissing: boolean;
}

export interface PcsApi {
  list(): Promise<PcView[]>;
  add(name: string, permissions: PcPermissions, pin: string): Promise<AddedPc>;
  reissue(id: number, pin: string): Promise<Omit<AddedPc, "pc">>;
  setPermissions(id: number, permissions: PcPermissions, pin: string): Promise<void>;
  revoke(id: number, pin: string): Promise<void>;
  remove(id: number, pin: string): Promise<void>;
  control(id: number, action: "start" | "stop", minutes?: number): Promise<void>;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}) } });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `That did not work (${res.status}).`);
  return body as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const httpPcsApi: PcsApi = {
  list: async () => (await call<{ pcs: PcView[] }>("/api/pc")).pcs,
  add: (name, permissions, pin) => call<AddedPc>("/api/pc", json("POST", { name, permissions, pin })),
  reissue: (id, pin) => call(`/api/pc/${id}/enrollment`, json("POST", { pin })),
  setPermissions: async (id, permissions, pin) => void (await call(`/api/pc/${id}/permissions`, json("PUT", { permissions, pin }))),
  revoke: async (id, pin) => void (await call(`/api/pc/${id}/revoke`, json("POST", { pin }))),
  remove: async (id, pin) => void (await call(`/api/pc/${id}`, json("DELETE", { pin }))),
  control: async (id, action, minutes) => void (await call(`/api/pc/${id}/control`, json("POST", { action, ...(minutes ? { minutes } : {}) }))),
};
