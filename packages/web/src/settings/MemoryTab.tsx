import type { ReactNode } from "react";
import "./office.css";
import type { MemorySettings } from "./settingsApi";

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

const whole = (v: string): number => (v.trim() === "" || !Number.isFinite(Number(v)) ? 0 : Math.round(Number(v)));

/**
 * What Friend remembers: whether memory is a tree of small notes, whether Friend saves by itself once you have paused, and how much of the
 * memory index it sees every turn. The notes themselves are plain files you can open; nothing about them is set here.
 */
export function MemoryTab({ memory, onChange }: { memory: MemorySettings; onChange: (p: Partial<MemorySettings>) => void }) {
  return (
    <div className="of-tab" data-on={memory.enabled ? "true" : "false"}>
      <section className="of-hero">
        <div>
          <div className="of-code">FRIEND · MEMORY</div>
          <h3>What Friend remembers</h3>
          <p className="of-note">
            Friend keeps what it knows about you as small notes in folders it makes itself, with one index to start from. The notes are plain files in your Friend data folder (open them with any editor, or see them with <b>friend memory list</b> in the terminal).
            Only the index goes into each conversation, so memory can grow without making every answer slower or dearer. Everything in a note is data about you, never an instruction.
          </p>
        </div>
        <label className="of-switch">
          <input type="checkbox" checked={memory.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
          <span className="of-track" aria-hidden="true">
            <i />
          </span>
          <span className="of-switch-text">Keep memory as a tree of notes</span>
          <b className="of-state">{memory.enabled ? "ON" : "OFF"}</b>
        </label>
      </section>

      <Card code="01" title="Saving by itself" note="Friend can notice what is worth keeping while you talk, so you do not have to say 'remember this'. It never keeps passwords, PINs, keys, card numbers or codes.">
        <label className="of-check">
          <input type="checkbox" checked={memory.autoSave === "on"} disabled={!memory.enabled} onChange={(e) => onChange({ autoSave: e.target.checked ? "on" : "off" })} /> Save what is worth keeping, by itself
          <small className="of-hint">After you have been quiet for a while, one separate step reads what was said and writes short notes: facts about you, decisions, corrections, where your projects stand. Small talk is not kept. Off means Friend saves only when you ask.</small>
        </label>
        <label className="of-check">
          <input type="checkbox" checked={memory.showSaved} disabled={!memory.enabled || memory.autoSave === "off"} onChange={(e) => onChange({ showSaved: e.target.checked })} /> Tell me what was remembered
          <small className="of-hint">A short line on the screen, for example "Remembered: family/priya.md".</small>
        </label>
        <div className="of-grid">
          <Field label="Wait after I stop talking (seconds)" hint="How long you must be quiet before it saves. From 10 to 3600.">
            <input type="number" min={10} max={3600} value={memory.saveDelaySec} disabled={!memory.enabled || memory.autoSave === "off"} onChange={(e) => onChange({ saveDelaySec: whole(e.target.value) })} />
          </Field>
        </div>
      </Card>

      <Card code="02" title="Keeping it in order" note="Quick notes land in an inbox. Friend can file them into topic folders (family, work, projects and so on), give them short titles, link notes that belong together and merge duplicates, so memory reads like a small wiki.">
        <label className="of-check">
          <input type="checkbox" checked={memory.autoTidy} disabled={!memory.enabled} onChange={(e) => onChange({ autoTidy: e.target.checked })} /> Tidy notes into topics, by itself
          <small className="of-hint">When a few notes have collected, and after Friend starts. You can also say "tidy my memory" at any time.</small>
        </label>
      </Card>

      <Card code="03" title="What it sees every turn" note="Friend always sees the top of the memory index and opens a folder only when a question needs it.">
        <div className="of-grid">
          <Field label="Index size (characters)" hint="The most of the index put in every conversation. A bigger index shows more of your memory at once but costs more each turn. From 400 to 6000.">
            <input type="number" min={400} max={6000} step={100} value={memory.maxIndexChars} disabled={!memory.enabled} onChange={(e) => onChange({ maxIndexChars: whole(e.target.value) })} />
          </Field>
        </div>
      </Card>
    </div>
  );
}
