import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { httpEnrollApi, type EnrollApi, type EnrollState } from "./enrollApi";
import { Recorder, type RecorderOptions } from "./recorder";

export type RecorderLike = Pick<Recorder, "start" | "stop" | "cancel">;

/** Short, natural sentences with a spread of sounds. Each takes a few seconds to read. */
const PHRASES = [
  "Friend, good evening. It is a pleasant day to get things done.",
  "Open my projects and show me what changed today.",
  "My voice is my key, so please remember it well.",
  "Check the weather and read me the latest headlines.",
  "Always protect the boss, and never trust a stranger.",
];
const MAX_RECORDING_MS = 15_000;

type View = "record" | "pin-save" | "pin-delete" | "saved" | "deleted";

export interface EnrollmentFlowProps {
  api?: EnrollApi;
  createRecorder?: (opts: RecorderOptions) => RecorderLike;
  onClose: () => void;
  /** The name of another person of the household, when this teaches their voice instead of the owner's. */
  who?: string;
}

/** Owner-opened panel that teaches Friend the owner's voice. Drawn by the client; saving or deleting needs the PIN. */
export function EnrollmentFlow({ api = httpEnrollApi, createRecorder = (o) => new Recorder(o), onClose, who }: EnrollmentFlowProps) {
  const [info, setInfo] = useState<EnrollState | null>(null);
  const [count, setCount] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [view, setView] = useState<View>("record");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const alive = useRef(true);
  const recorder = useRef<RecorderLike | null>(null);

  useEffect(() => {
    alive.current = true;
    api
      .state()
      .then((s) => {
        if (!alive.current) return;
        setInfo(s);
        setCount(s.samples);
      })
      .catch((e: Error) => alive.current && setError(e.message));
    return () => {
      alive.current = false;
      recorder.current?.cancel(); // never leave the microphone open
      recorder.current = null;
    };
  }, [api]);

  const stop = useCallback(async () => {
    const rec = recorder.current;
    if (!rec) return;
    recorder.current = null;
    setRecording(false);
    setBusy(true);
    try {
      const audio = await rec.stop();
      const out = await api.sample(audio);
      if (!alive.current) return;
      setCount(out.count);
      setNote(out.note);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [api]);

  const start = async () => {
    setError(null);
    setNote(null);
    const rec = createRecorder({ maxMs: MAX_RECORDING_MS, onLimit: () => void stop(), onError: () => {
      recorder.current = null;
      if (alive.current) {
        setRecording(false);
        setError("The microphone stopped working. Try again.");
      }
    } });
    try {
      await rec.start();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
      return;
    }
    if (!alive.current) return rec.cancel();
    recorder.current = rec;
    setRecording(true);
  };

  const run = async (job: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await job();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) {
        setBusy(false);
        setPin("");
      }
    }
  };

  const cancel = async () => {
    recorder.current?.cancel();
    recorder.current = null;
    await api.cancel().catch(() => {});
    onClose();
  };

  const min = info?.min ?? 3;
  const phraseNo = count % PHRASES.length;
  const label = count < PHRASES.length ? `Phrase ${count + 1} of ${PHRASES.length}` : `Extra recording (${count} so far)`;

  return (
    <div className="approval enroll glass" role="dialog" aria-label="Voice enrollment" style={{ pointerEvents: "auto" }}>
      <div className="approval-head">
        <span className="approval-title">{who ? `Teach Friend ${who}'s voice` : "Teach Friend your voice"}</span>
      </div>

      {view === "record" && (
        <>
          {!who && info?.enrolled && <p className="auth-note">Your voice is already saved. Saving a new one replaces it.</p>}
          {who && <p className="auth-note">Hand the device to {who}. {who} reads each sentence aloud, close to the microphone, in a quiet room.</p>}
          <p className="auth-note">{label}. Press Record, read this aloud in a quiet room, then press Stop.</p>
          <pre className="approval-summary" data-testid="enroll-phrase" style={{ whiteSpace: "pre-wrap" }}>
            {PHRASES[phraseNo]}
          </pre>
          <div role="status" className="auth-note">
            {count} recorded{count >= min ? " — enough to save" : ` — at least ${min} needed`}.{note ? ` ${note}` : ""}
          </div>
          {error && (
            <p role="alert" className="auth-error">
              {error}
            </p>
          )}
          <div className="approval-actions">
            {recording ? (
              <button type="button" style={touch} className="danger" onClick={() => void stop()}>
                Stop
              </button>
            ) : (
              <button type="button" style={touch} className="primary" disabled={busy || !info || count >= (info?.max ?? 8)} onClick={() => void start()}>
                {busy ? "Uploading…" : "Record"}
              </button>
            )}
            <button type="button" style={touch} disabled={recording || busy || count < min} onClick={() => setView("pin-save")}>
              {who ? `Save ${who}'s voice` : "Save my voice"}
            </button>
            {!who && info?.enrolled && (
              <button type="button" style={touch} className="danger" disabled={recording || busy} onClick={() => setView("pin-delete")}>
                Delete my voice
              </button>
            )}
            <button type="button" style={touch} onClick={() => void cancel()}>
              Cancel
            </button>
          </div>
        </>
      )}

      {(view === "pin-save" || view === "pin-delete") && (
        <>
          <p className="auth-note">{view === "pin-save" ? (who ? `Enter your PIN to save ${who}'s voice.` : "Enter your PIN to save your voice.") : "Enter your PIN to delete your saved voice."}</p>
          <PinPad
            pin={pin}
            onChange={setPin}
            onSubmit={
              view === "pin-save" // Enter saves; deleting your voice always needs a deliberate click
                ? () =>
                    !busy &&
                    void run(async () => {
                      await api.finish(pin);
                      if (alive.current) setView("saved");
                    })
                : undefined
            }
          />
          {error && (
            <p role="alert" className="auth-error">
              {error}
            </p>
          )}
          <div className="approval-actions">
            {view === "pin-save" ? (
              <button
                type="button"
                style={touch}
                className="primary"
                disabled={busy || pin.length < 6}
                onClick={() =>
                  void run(async () => {
                    await api.finish(pin);
                    if (alive.current) setView("saved");
                  })
                }
              >
                Save
              </button>
            ) : (
              <button
                type="button"
                style={touch}
                className="danger"
                disabled={busy || pin.length < 6}
                onClick={() =>
                  void run(async () => {
                    await api.remove(pin);
                    if (alive.current) setView("deleted");
                  })
                }
              >
                Delete
              </button>
            )}
            <button
              type="button"
              style={touch}
              onClick={() => {
                setPin("");
                setError(null);
                setView("record");
              }}
            >
              Back
            </button>
          </div>
        </>
      )}

      {(view === "saved" || view === "deleted") && (
        <>
          <p className="auth-note">
            {view === "saved"
              ? who
                ? `${who}'s voice is saved. From now on I will know when ${who} is talking.`
                : "Your voice is saved. From now on I will tell you apart from other speakers."
              : "Your voice was deleted. Every voice is treated as yours until you enroll again."}
          </p>
          <div className="approval-actions">
            <button type="button" style={touch} className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}
