export type ConnectorStatus = "off" | "connecting" | "ready" | "error";

export interface ConnectorView {
  id: string;
  name: string;
  kind: "stdio" | "http";
  enabled: boolean;
  status: ConnectorStatus;
  error: string | null;
  tools: number;
  target: string;
  /** A token or key is stored for it. The value is never sent to the screen. */
  secret: boolean;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  connector: { id: string; name: string; kind: "stdio"; command: string; args: string[] };
  setup: string[];
  warning?: string;
  /** One click: no form; Friend checks what it needs and connects it. */
  quick?: boolean;
}

export interface ConnectorList {
  connectors: ConnectorView[];
  presets: Preset[];
}

/** What the owner fills in. `env` and `headers` are where secrets go; they are saved privately and never shown again. */
export type NewConnector =
  | { id: string; name: string; kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { id: string; name: string; kind: "http"; url: string; headers: Record<string, string> };

/** What a one-click connector needs, and whether it is on this PC. */
export interface QuickCheck {
  preset: string;
  name: string;
  ready: boolean;
  message: string;
  installCommand: string | null;
  manualStep: string | null;
  extensionFolder: string | null;
}
export interface QuickConnectResult {
  ok: boolean;
  connector: { id: string; name: string; status: string; error: string | null; tools: number } | null;
  extension: "connected" | "off" | "unknown";
  message: string;
}
export interface QuickInstallResult {
  ok: boolean;
  output: string;
  extensionFolder: string | null;
  message: string;
}

export interface ConnectorsApi {
  quickCheck(preset: string): Promise<QuickCheck>;
  quickInstall(preset: string, pin: string): Promise<QuickInstallResult>;
  quickConnect(preset: string, pin: string): Promise<QuickConnectResult>;
  list(): Promise<ConnectorList>;
  add(connector: NewConnector, pin: string): Promise<ConnectorView>;
  setEnabled(id: string, enabled: boolean, pin?: string): Promise<ConnectorView>;
  reload(id: string): Promise<ConnectorView>;
  remove(id: string): Promise<void>;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/connectors${path}`, init);
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
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

export const httpConnectorsApi: ConnectorsApi = {
  list: () => call<ConnectorList>(""),
  quickCheck: (preset) => call<QuickCheck>(`/quick/${encodeURIComponent(preset)}`),
  quickInstall: (preset, pin) => call<QuickInstallResult>(`/quick/${encodeURIComponent(preset)}/install`, json("POST", { pin })),
  quickConnect: (preset, pin) => call<QuickConnectResult>(`/quick/${encodeURIComponent(preset)}/connect`, json("POST", { pin })),
  add: (connector, pin) => call<ConnectorView>("", json("POST", { pin, connector })),
  setEnabled: (id, enabled, pin) => call<ConnectorView>(`/${encodeURIComponent(id)}/enabled`, json("POST", { enabled, ...(pin ? { pin } : {}) })),
  reload: (id) => call<ConnectorView>(`/${encodeURIComponent(id)}/reload`, json("POST", {})),
  remove: async (id) => {
    await call(`/${encodeURIComponent(id)}`, json("DELETE"));
  },
};

/** One argument per line; blank lines are skipped. */
export const parseLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** `NAME=value` per line. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of parseLines(text)) {
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error(`"${line.slice(0, 30)}" should look like NAME=value`);
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** `Name: value` per line. */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of parseLines(text)) {
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`"${line.slice(0, 30)}" should look like Name: value`);
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}
