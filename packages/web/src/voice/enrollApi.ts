export interface EnrollState {
  enrolled: boolean;
  samples: number;
  min: number;
  max: number;
}

export interface EnrollApi {
  state(): Promise<EnrollState>;
  sample(audio: Blob): Promise<{ count: number; note: string | null }>;
  finish(pin: string): Promise<{ samples: number }>;
  cancel(): Promise<void>;
  remove(pin: string): Promise<void>;
}

const STATUS_TEXT: Record<number, string> = {
  401: "Please sign in again.",
  403: "Incorrect PIN.",
  413: "That recording was too long.",
  429: "Too many attempts. Wait a moment.",
  503: "Voice is not available. Run: friend voice setup",
};

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
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
    throw new Error(detail || STATUS_TEXT[res.status] || `The request failed (${res.status}).`);
  }
  return (await res.json()) as T;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** The enrollment endpoints of the gateway. */
export const httpEnrollApi: EnrollApi = {
  state: () => call<EnrollState>("/api/voice/enroll", {}),
  sample: (audio) =>
    call("/api/voice/enroll/sample", { method: "POST", headers: { "content-type": audio.type || "audio/webm" }, body: audio }),
  finish: (pin) => call("/api/voice/enroll/finish", jsonInit("POST", { pin })),
  cancel: async () => {
    await call("/api/voice/enroll/cancel", jsonInit("POST", {}));
  },
  remove: async (pin) => {
    await call("/api/voice/enroll", jsonInit("DELETE", { pin }));
  },
};
