export type ProviderName = "claude" | "claude-code" | "ollama";

export interface SettingsView {
  provider: ProviderName;
  model: string;
  /** The key itself is never sent to the screen. */
  apiKeySet: boolean;
  view: "minimal" | "companion" | "workspace";
  ollama: { url: string; model: string; vision: boolean; contextTokens: number };
  claudeCode: { model: string; command: string; fallback: "ollama" | "none" };
  voice: { enabled: boolean; speakTyped: boolean; language: string | null; accept: number; challenge: number; ttsVoice: string; sttModel: string };
}

export interface SaveResult {
  settings: SettingsView;
  changed: boolean;
  /** Settings that only take effect after Friend restarts. */
  restart: string[];
}

export interface SettingsApi {
  get(): Promise<SettingsView>;
  /** The PIN is needed for everything except the view. */
  save(settings: Record<string, unknown>, pin?: string): Promise<SaveResult>;
}

async function call<T>(init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api/settings", init);
  } catch {
    throw new Error("Could not reach Friend. Check the connection.");
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* no JSON body */
    }
    throw new Error(detail || (res.status === 401 ? "Please sign in again." : res.status === 429 ? "Too many attempts. Wait a moment." : `The request failed (${res.status}).`));
  }
  return (await res.json()) as T;
}

export const httpSettingsApi: SettingsApi = {
  get: () => call<SettingsView>(),
  save: (settings, pin) => call<SaveResult>({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(pin ? { pin } : {}), settings }) }),
};

/** Only what the owner actually changed, in the shape the server accepts. `apiKey` is sent only when something was typed. */
export function diffSettings(before: SettingsView, after: SettingsView, apiKey: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (after.provider !== before.provider) patch.provider = after.provider;
  if (after.model !== before.model) patch.model = after.model;
  if (after.view !== before.view) patch.view = after.view;
  if (apiKey.trim()) patch.apiKey = apiKey.trim();
  for (const group of ["ollama", "claudeCode", "voice"] as const) {
    const changed: Record<string, unknown> = {};
    for (const k of Object.keys(after[group]) as string[]) {
      const a = (after[group] as Record<string, unknown>)[k];
      if (a !== (before[group] as Record<string, unknown>)[k]) changed[k] = group === "voice" && k === "language" ? (a ?? "") : a;
    }
    if (Object.keys(changed).length) patch[group] = changed;
  }
  return patch;
}
