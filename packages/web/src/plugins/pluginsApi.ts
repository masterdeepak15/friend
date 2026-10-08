export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  /** Why the plugin cannot be used, or null. */
  error: string | null;
  skills: { name: string; description: string }[];
  tools: { name: string; description: string }[];
}

export interface CatalogPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  tools: number;
  skills: number;
  error: string | null;
  installed: boolean;
}

export interface PluginList {
  installed: InstalledPlugin[];
  catalog: CatalogPlugin[];
}

export interface PluginsApi {
  list(): Promise<PluginList>;
  install(id: string, pin: string): Promise<void>;
  setEnabled(id: string, enabled: boolean, pin?: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Reads every plugin from disk again. */
  reload(): Promise<void>;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/plugins${path}`, init);
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

export const httpPluginsApi: PluginsApi = {
  list: () => call<PluginList>(""),
  install: async (id, pin) => {
    await call("/install", json("POST", { id, pin }));
  },
  setEnabled: async (id, enabled, pin) => {
    await call(`/${encodeURIComponent(id)}/enabled`, json("POST", { enabled, ...(pin ? { pin } : {}) }));
  },
  remove: async (id) => {
    await call(`/${encodeURIComponent(id)}`, json("DELETE"));
  },
  reload: async () => {
    await call("/reload", json("POST", {}));
  },
};
