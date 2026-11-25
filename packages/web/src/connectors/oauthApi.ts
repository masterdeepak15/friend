export interface OAuthService {
  id: string;
  name: string;
  /** The host has registered a client ID for it. */
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
  account: string | null;
  /** The exact return address to register with the service. */
  redirectUri: string;
}

export interface OAuthConnector {
  id: string;
  name: string;
  status: "off" | "connecting" | "ready" | "error" | "needs-approval";
  connected: boolean;
  account: string | null;
}

export interface OAuthState {
  services: OAuthService[];
  connectors: OAuthConnector[];
  redirectUri: string;
}

export interface OAuthApi {
  state(): Promise<OAuthState>;
  connectService(id: string, toPhone: boolean): Promise<{ link: string; sent: boolean }>;
  disconnectService(id: string): Promise<void>;
  connectConnector(id: string, toPhone: boolean): Promise<{ link?: string; sent?: boolean; connected?: boolean }>;
  disconnectConnector(id: string): Promise<void>;
  setClient(id: string, clientId: string, clientSecret: string | undefined, pin: string): Promise<void>;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/oauth${path}`, init);
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
    throw new Error(detail || (res.status === 401 ? "Please sign in again." : `The request failed (${res.status}).`));
  }
  return (await res.json()) as T;
}
const send = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const seg = encodeURIComponent;

export const httpOAuthApi: OAuthApi = {
  state: () => call<OAuthState>(""),
  connectService: (id, toPhone) => call(`/services/${seg(id)}/connect`, send("POST", { toPhone })),
  disconnectService: async (id) => void (await call(`/services/${seg(id)}/disconnect`, send("POST", {}))),
  connectConnector: (id, toPhone) => call(`/connectors/${seg(id)}/connect`, send("POST", { toPhone })),
  disconnectConnector: async (id) => void (await call(`/connectors/${seg(id)}/disconnect`, send("POST", {}))),
  setClient: async (id, clientId, clientSecret, pin) => void (await call(`/services/${seg(id)}/client`, send("PUT", { clientId, ...(clientSecret ? { clientSecret } : {}), pin }))),
};
