import type { ReactNode } from "react";
import "./office.css";
import type { ProactiveSettings } from "./settingsApi";

const LEVELS: { id: ProactiveSettings["level"]; name: string; text: string }[] = [
  { id: "off", name: "Off", text: "Friend never starts a conversation. It only answers, and reminds you of what you asked." },
  { id: "low", name: "Low", text: "Friend speaks first only about what you asked for: a task that is long overdue." },
  { id: "medium", name: "Medium", text: "Also a morning check-in and an evening check-in, and a word about anything in memory dated today or tomorrow." },
  { id: "high", name: "High", text: "Also a gentle check-in when you have been silent for a long time, like a friend who notices." },
];

const num = (v: string): number => (v.trim() === "" || !Number.isFinite(Number(v)) ? 0 : Math.round(Number(v)));

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="of-field">
      <span className="of-label">{label}</span>
      {children}
      {hint && <small className="of-hint">{hint}</small>}
    </label>
  );
}

function Card({ code, title, note, children }: { code: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section className="of-card">
      <header className="of-card-head">
        <span className="of-code">{code}</span>
        <h4>{title}</h4>
      </header>
      {note && <p className="of-note">{note}</p>}
      <div className="of-card-body">{children}</div>
    </section>
  );
}

/** Whether the numbers here are inside what the server accepts. */
export const heartbeatBad = (p: ProactiveSettings): boolean => p.dailyCap < 1 || p.dailyCap > 20 || p.minGapMin < 5 || p.minGapMin > 720 || p.silenceHours < 2 || p.silenceHours > 72;

/**
 * When Friend may speak first. A quiet check runs all day and costs nothing; Friend only asks the model whether to say something when a reason
 * turns up and these limits allow it. Off is the default.
 */
export function HeartbeatTab({ proactive, onChange }: { proactive: ProactiveSettings; onChange: (p: Partial<ProactiveSettings>) => void }) {
  const off = proactive.level === "off";
  return (
    <div className="of-tab" data-on={off ? "false" : "true"}>
      <section className="of-hero">
        <div>
          <div className="of-code">FRIEND · HEARTBEAT</div>
          <h3>Friend speaks first</h3>
          <p className="of-note">
            Today Friend only answers. With the heartbeat on, it can start the conversation when it has something worth saying. Every minute it quietly checks for a reason (a task long overdue, the morning, the evening, a note in memory with today's date, a long silence). Only when it finds one, and your limits below allow it, does it ask the model whether to say anything, and the model can only choose words: it cannot run tools or change anything. It never cuts in while you are talking.
          </p>
        </div>
        <b className="of-state">{off ? "OFF" : proactive.level.toUpperCase()}</b>
      </section>

      <Card code="01" title="How much" note="Pick how often Friend may reach out. You can change it, or turn it off, at any time.">
        <div className="of-levels" role="radiogroup" aria-label="How much Friend speaks first">
          {LEVELS.map((l) => (
            <label key={l.id} className="of-level" data-on={proactive.level === l.id ? "true" : "false"}>
              <input type="radio" name="hb-level" checked={proactive.level === l.id} onChange={() => onChange({ level: l.id })} />
              <b>{l.name}</b>
              <small className="of-hint">{l.text}</small>
            </label>
          ))}
        </div>
      </Card>

      <Card code="02" title="Times" note="Friend does not contact you at all during quiet hours.">
        <div className="of-grid">
          <Field label="Quiet from">
            <input type="time" value={proactive.quietFrom} disabled={off} onChange={(e) => e.target.value && onChange({ quietFrom: e.target.value })} />
          </Field>
          <Field label="Quiet until">
            <input type="time" value={proactive.quietTo} disabled={off} onChange={(e) => e.target.value && onChange({ quietTo: e.target.value })} />
          </Field>
          <Field label="Morning check-in from" hint="Medium and high.">
            <input type="time" value={proactive.morningAt} disabled={off} onChange={(e) => e.target.value && onChange({ morningAt: e.target.value })} />
          </Field>
          <Field label="Evening check-in from" hint="Medium and high.">
            <input type="time" value={proactive.eveningAt} disabled={off} onChange={(e) => e.target.value && onChange({ eveningAt: e.target.value })} />
          </Field>
        </div>
      </Card>

      <Card code="03" title="Limits" note="So it never becomes a nuisance.">
        <div className="of-grid">
          <Field label="Most contacts in a day" hint="From 1 to 20.">
            <input type="number" min={1} max={20} value={proactive.dailyCap} disabled={off} onChange={(e) => onChange({ dailyCap: num(e.target.value) })} />
          </Field>
          <Field label="Least minutes between two" hint="From 5 to 720.">
            <input type="number" min={5} max={720} value={proactive.minGapMin} disabled={off} onChange={(e) => onChange({ minGapMin: num(e.target.value) })} />
          </Field>
          <Field label="Hours of silence before a check-in" hint="High only. From 2 to 72.">
            <input type="number" min={2} max={72} value={proactive.silenceHours} disabled={off || proactive.level !== "high"} onChange={(e) => onChange({ silenceHours: num(e.target.value) })} />
          </Field>
        </div>
      </Card>

      <Card code="04" title="How it reaches you">
        <label className="of-check">
          <input type="checkbox" checked={proactive.speak} disabled={off} onChange={(e) => onChange({ speak: e.target.checked })} /> Say it aloud as well as on the screen
          <small className="of-hint">Off by default, so it never startles you. It always appears on the screen when one is open.</small>
        </label>
        <label className="of-check">
          <input type="checkbox" checked={proactive.phone} disabled={off} onChange={(e) => onChange({ phone: e.target.checked })} /> When no screen is open, message my phone
          <small className="of-hint">Needs Telegram installed and linked (Plugins). Without it, Friend waits until a screen is open.</small>
        </label>
      </Card>
    </div>
  );
}
