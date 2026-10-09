import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { EnrollmentFlow, type EnrollmentFlowProps } from "./EnrollmentFlow";
import { httpHouseholdApi, type HouseholdApi, type HouseholdOverview, type PersonView } from "./householdApi";

type Step = { kind: "list" } | { kind: "record"; name: string } | { kind: "remove"; person: PersonView };

export interface HouseholdPanelProps {
  api?: HouseholdApi;
  createRecorder?: EnrollmentFlowProps["createRecorder"];
  onClose: () => void;
}

/**
 * Owner-opened panel for the other people Friend should know by voice (wife, son, daughter...). Each person records a few
 * sentences on this device; saving or removing a voice needs the owner's PIN. The assistant then knows who is talking.
 */
export function HouseholdPanel({ api = httpHouseholdApi, createRecorder, onClose }: HouseholdPanelProps) {
  const [info, setInfo] = useState<HouseholdOverview | null>(null);
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(() => {
    api
      .overview()
      .then((o) => alive.current && setInfo(o))
      .catch((e: Error) => alive.current && setError(e.message));
  }, [api]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const begin = async () => {
    setError(null);
    setBusy(true);
    try {
      const out = await api.begin(name.trim());
      if (alive.current) setStep({ kind: "record", name: out.name });
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const remove = async (person: PersonView) => {
    setError(null);
    setBusy(true);
    try {
      await api.removePerson(person.id, pin);
      if (!alive.current) return;
      setStep({ kind: "list" });
      load();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) {
        setBusy(false);
        setPin("");
      }
    }
  };

  if (step.kind === "record") {
    return (
      <EnrollmentFlow
        api={api.recording}
        who={step.name}
        {...(createRecorder ? { createRecorder } : {})}
        onClose={() => {
          setName("");
          setStep({ kind: "list" });
          load();
        }}
      />
    );
  }

  return (
    <div className="approval enroll glass" role="dialog" aria-label="Family voices" style={{ pointerEvents: "auto" }}>
      <div className="approval-head">
        <span className="approval-title">Family voices</span>
      </div>

      {step.kind === "list" && (
        <>
          <p className="auth-note">Friend knows your voice. Add the people at home, so it knows who is talking and answers them by name. They can chat and ask for the weather, but cannot use your PC or see your private things.</p>
          {info && !info.ownerEnrolled && <p className="auth-note">First teach Friend your own voice (Esc, then Enroll my voice).</p>}
          {info && info.people.length === 0 && info.ownerEnrolled && <p className="auth-note">Nobody added yet.</p>}
          {info && info.people.length > 0 && (
            <ul className="household-list" aria-label="People Friend knows">
              {info.people.map((p) => (
                <li key={p.id} className="household-row">
                  <span>{p.name}</span>
                  <button type="button" style={touch} className="danger" onClick={() => setStep({ kind: "remove", person: p })} aria-label={`Remove ${p.name}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {info && info.ownerEnrolled && info.people.length < info.max && (
            <label className="settings-field">
              <span>Add a person</span>
              <input value={name} maxLength={40} placeholder="Name, for example Priya" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && void begin()} />
            </label>
          )}
          {error && (
            <p role="alert" className="auth-error">
              {error}
            </p>
          )}
          <div className="approval-actions">
            {info && info.ownerEnrolled && info.people.length < info.max && (
              <button type="button" style={touch} className="primary" disabled={busy || !name.trim()} onClick={() => void begin()}>
                Record their voice
              </button>
            )}
            <button type="button" style={touch} onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}

      {step.kind === "remove" && (
        <>
          <p className="auth-note">Enter your PIN to remove {step.person.name}&rsquo;s voice. Friend will treat their voice as a stranger&rsquo;s.</p>
          <PinPad pin={pin} onChange={setPin} />
          {error && (
            <p role="alert" className="auth-error">
              {error}
            </p>
          )}
          <div className="approval-actions">
            <button type="button" style={touch} className="danger" disabled={busy || pin.length < 6} onClick={() => void remove(step.person)}>
              Remove
            </button>
            <button
              type="button"
              style={touch}
              onClick={() => {
                setPin("");
                setError(null);
                setStep({ kind: "list" });
              }}
            >
              Back
            </button>
          </div>
        </>
      )}
    </div>
  );
}
