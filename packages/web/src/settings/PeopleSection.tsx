import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";

export interface PersonRow {
  id: number;
  name: string;
  relation: string;
  addedAt: number;
  /** False when the saved face numbers cannot be read any more (the key was lost): the person has to be introduced again. */
  usable: boolean;
}

export interface PeopleApi {
  list(): Promise<PersonRow[]>;
  /** Both need the PIN. */
  remove(id: number, pin: string): Promise<void>;
  forgetAll(pin: string): Promise<void>;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("Could not reach Friend. Check the connection.");
  }
  let body: { error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* no JSON body */
  }
  if (!res.ok) throw new Error(body.error ?? (res.status === 401 ? "Please sign in again." : res.status === 403 ? "Incorrect PIN" : `The request failed (${res.status}).`));
  return body as T;
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const httpPeopleApi: PeopleApi = {
  list: () => call("/api/people"),
  remove: async (id, pin) => void (await call("/api/people/remove", post({ id, pin }))),
  forgetAll: async (pin) => void (await call("/api/people/forget", post({ pin }))),
};

type Ask = { kind: "one"; person: PersonRow } | { kind: "all" } | null;

/**
 * The people Friend remembers: only people the owner introduced, kept as numbers about the face (never a picture). Forgetting one person
 * or everyone needs the PIN and deletes the numbers and the notes about them.
 */
export function PeopleSection({ api = httpPeopleApi }: { api?: PeopleApi }) {
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const list = await api.list();
      if (alive.current) setPeople(list);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const go = async () => {
    if (!ask || busy || pin.length < 6) return;
    setBusy(true);
    setError(null);
    try {
      if (ask.kind === "one") await api.remove(ask.person.id, pin);
      else await api.forgetAll(pin);
      if (!alive.current) return;
      setAsk(null);
      await refresh();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) {
        setBusy(false);
        setPin("");
      }
    }
  };

  if (ask) {
    return (
      <div className="settings-section" aria-label="Forget people">
        <p className="auth-note">{ask.kind === "one" ? `Enter your PIN to forget ${ask.person.name}. Their saved face numbers and the notes about them are deleted.` : "Enter your PIN to forget everyone. All saved face numbers and the notes about them are deleted."}</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => void go()} />
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={() => void go()}>
            Continue
          </button>
          <button
            type="button"
            style={touch}
            onClick={() => {
              setAsk(null);
              setPin("");
              setError(null);
            }}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section" aria-label="People Friend remembers">
      <h3>People Friend remembers</h3>
      {people && people.length === 0 && <p className="auth-note">Friend does not remember anyone yet. Say "this is Priya, my sister" while she is in front of the camera and Friend asks for your PIN.</p>}
      {people?.map((p) => (
        <div key={p.id} className="settings-check" style={{ justifyContent: "space-between" }}>
          <span>
            <b>{p.name}</b>
            {p.relation ? ` (${p.relation})` : ""}
            {!p.usable && <small className="auth-note"> Their saved face cannot be read any more: introduce them again.</small>}
          </span>
          <button type="button" style={touch} aria-label={`Remove ${p.name}`} onClick={() => setAsk({ kind: "one", person: p })}>
            Remove
          </button>
        </div>
      ))}
      {people && people.length > 0 && (
        <div className="approval-actions">
          <button type="button" style={touch} onClick={() => setAsk({ kind: "all" })}>
            Forget everyone
          </button>
        </div>
      )}
      <small className="auth-note">
        Face data is sensitive personal data. Introduce only people who know and agree, and not children. Friend keeps 128 numbers about a face, encrypted on this PC, never the picture, and never uses a face to approve anything.
      </small>
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
    </div>
  );
}
