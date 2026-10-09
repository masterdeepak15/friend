import type { EnrollApi, EnrollState } from "./enrollApi";

export interface PersonView {
  id: number;
  name: string;
  samples: number;
  createdAt: number;
}

export interface HouseholdOverview {
  people: PersonView[];
  max: number;
  ownerEnrolled: boolean;
  enrolling: (EnrollState & { name: string }) | null;
}

export interface HouseholdApi {
  overview(): Promise<HouseholdOverview>;
  /** Starts teaching Friend one person's voice; resolves with the recording state. */
  begin(name: string): Promise<EnrollState & { name: string }>;
  /** The recording steps for the person being taught, in the shape the enrollment screen uses. */
  recording: EnrollApi;
  removePerson(id: number, pin: string): Promise<void>;
}

const STATUS_TEXT: Record<number, string> = {
  401: "Please sign in again.",
  403: "Incorrect PIN.",
  413: "That recording was too long.",
  429: "Too many attempts. Wait a moment.",
  503: "Voice is not available. Run: friend voice setup",
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
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

const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The household endpoints of the gateway. */
export const httpHouseholdApi: HouseholdApi = {
  overview: () => call<HouseholdOverview>("/api/voice/people"),
  begin: (name) => call("/api/voice/people/begin", jsonInit("POST", { name })),
  recording: {
    state: async () => {
      const o = await call<HouseholdOverview>("/api/voice/people");
      return o.enrolling ?? { enrolled: false, samples: 0, min: 3, max: 8 };
    },
    sample: (audio) => call("/api/voice/people/sample", { method: "POST", headers: { "content-type": audio.type || "audio/webm" }, body: audio }),
    finish: (pin) => call("/api/voice/people/finish", jsonInit("POST", { pin })),
    cancel: async () => {
      await call("/api/voice/people/cancel", jsonInit("POST", {}));
    },
    remove: async () => {
      /* a person is removed from the list, not from the recording screen */
    },
  },
  removePerson: async (id, pin) => {
    await call(`/api/voice/people/${id}`, jsonInit("DELETE", { pin }));
  },
};
