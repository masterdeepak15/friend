export interface MeetingView {
  id: number;
  title: string;
  status: "scheduled" | "joining" | "lobby" | "live" | "ended" | "failed" | "cancelled";
  detail: string;
  startsAt: number;
  startedAt: number;
  endedAt: number;
  host: string;
  summary: string;
  decisions: string[];
  tasks: { what: string; who?: string; due?: string }[];
  lines: number;
}

export interface MeetingsApi {
  list(): Promise<MeetingView[]>;
  leave(id: number): Promise<string>;
  remove(id: number): Promise<void>;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `That did not work (${res.status}).`);
  return body as T;
}

export const httpMeetingsApi: MeetingsApi = {
  list: async () => (await call<{ meetings: MeetingView[] }>("/api/meetings")).meetings,
  leave: async (id) => (await call<{ message: string }>(`/api/meetings/${id}/leave`, { method: "POST" })).message,
  remove: async (id) => void (await call(`/api/meetings/${id}`, { method: "DELETE" })),
};
