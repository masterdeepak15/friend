import { OfficeProject, OfficeRole, SLUG } from "@friend/protocol";
import { useEffect, useState, type ReactNode } from "react";
import "./office.css";
import type { OfficeSettings } from "./settingsApi";

const MAX_EXTRA_FOLDERS = 5;
const MAX_LIST = 40;

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const validPattern = (p: string): boolean => {
  try {
    new RegExp(p, "i"); // the same way the server reads it
    return true;
  } catch {
    return false;
  }
};

const idProblem = (what: string, n: number, id: string, earlier: string[]): string | null => {
  if (!SLUG.test(id)) return `${what} ${n}: the id must be lowercase letters, digits or dashes, up to 24 characters, starting with a letter or digit.`;
  if (earlier.includes(id)) return `${what} ${n} has the same id as an earlier one (${id}).`;
  return null;
};

/** What is wrong with one role, in plain words (an empty list: nothing). */
export function roleProblems(roles: OfficeRole[], i: number): string[] {
  const r = roles[i]!;
  const out = [idProblem("Role", i + 1, r.id, roles.slice(0, i).map((x) => x.id))];
  if (!r.title.trim()) out.push(`Role ${i + 1} needs a title.`);
  else if (r.title.length > 40) out.push(`Role ${i + 1}: the title is at most 40 characters.`);
  if (r.instructions.length > 4000) out.push(`Role ${i + 1}: the instructions are at most 4000 characters.`);
  return out.filter((p): p is string => !!p);
}

export function projectProblems(projects: OfficeProject[], i: number): string[] {
  const p = projects[i]!;
  const out = [idProblem("Project", i + 1, p.id, projects.slice(0, i).map((x) => x.id))];
  if (!p.name.trim()) out.push(`Project ${i + 1} needs a name.`);
  if (!p.folder.trim()) out.push(`Project ${i + 1} needs a folder.`);
  if (p.extraFolders.length > MAX_EXTRA_FOLDERS) out.push(`Project ${i + 1} can have at most ${MAX_EXTRA_FOLDERS} extra folders.`);
  return out.filter((x): x is string => !!x);
}

/** One message for each command pattern that is not a valid regular expression. */
export function patternProblems(patterns: string[]): string[] {
  return patterns.flatMap((p, i) => (validPattern(p) ? [] : [`Line ${i + 1}: ${p} is not a valid pattern.`]));
}

/** Everything that stops the Office settings from being saved. */
export function officeProblems(o: OfficeSettings): string[] {
  return [
    ...o.roles.flatMap((_, i) => roleProblems(o.roles, i)),
    ...o.projects.flatMap((_, i) => projectProblems(o.projects, i)),
    ...patternProblems(o.policy.denyCommands),
    ...(o.policy.allowTools.length > MAX_LIST ? [`At most ${MAX_LIST} tools can be let through.`] : []),
    ...(o.policy.denyCommands.length > MAX_LIST ? [`At most ${MAX_LIST} command patterns can be refused.`] : []),
  ];
}

function Field({ label, hint, children, wide = false }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`of-field${wide ? " of-wide" : ""}`}>
      <span className="of-label">{label}</span>
      {children}
      {hint && <small className="of-hint">{hint}</small>}
    </label>
  );
}

/** A box with one entry per line. It keeps what is being typed (blank lines too) and follows the settings when they change from outside, such as Undo. */
function LinesArea({ value, onChange, label, rows }: { value: string[]; onChange: (v: string[]) => void; label?: string; rows: number }) {
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => {
    setText((t) => (JSON.stringify(lines(t)) === JSON.stringify(value) ? t : value.join("\n")));
  }, [value]);
  return (
    <textarea
      rows={rows}
      spellCheck={false}
      {...(label ? { "aria-label": label } : {})}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(lines(e.target.value));
      }}
    />
  );
}

const Problems = ({ list }: { list: string[] }) => (
  <>
    {list.map((p) => (
      <p key={p} className="of-problem" data-problem="">
        {p}
      </p>
    ))}
  </>
);

/** A panel of the Office screen: a cut-corner frame with a lit title bar. */
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

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The Office: whether it is on, how many workers run at once, their limits, the roles and projects the owner defines, and the rules the
 * gate follows. Nothing here is preset in the component: it shows what the settings hold, and blank forms for what is added.
 */
export function OfficeTab({ office, onChange }: { office: OfficeSettings; onChange: (p: Partial<OfficeSettings>) => void }) {
  const setRole = (i: number, p: Partial<OfficeRole>) => onChange({ roles: office.roles.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const setProject = (i: number, p: Partial<OfficeProject>) => onChange({ projects: office.projects.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const num = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? 0 : Number(v));
  const patterns = office.policy.denyCommands;
  return (
    <div className="of-tab" data-on={office.enabled ? "true" : "false"}>
      <section className="of-hero">
        <div>
          <div className="of-code">FRIEND · OFFICE</div>
          <h3>Hired workers</h3>
          <p className="of-note">Friend can hire workers: separate Claude Code sessions that work in your project folders, one ticket at a time. Workers use the Claude Code program and model chosen under Model, and every risky step asks you first. Switched off, no worker runs. On the orbital screen, hired workers take the place of the quick-launch buttons.</p>
        </div>
        <label className="of-switch">
          <input type="checkbox" checked={office.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
          <span className="of-track" aria-hidden="true">
            <i />
          </span>
          <span className="of-switch-text">Turn the Office on</span>
          <b className="of-state">{office.enabled ? "ONLINE" : "OFFLINE"}</b>
        </label>
      </section>

      <label className="of-check">
        <input type="checkbox" checked={office.notifyFriend} onChange={(e) => onChange({ notifyFriend: e.target.checked })} /> Tell Friend when a worker finishes
        <small className="of-hint">Friend is told when a ticket is done or stuck, says so, and can review it and give the next ticket, so the work keeps moving. Switch it off and he only knows what you ask him.</small>
      </label>

      <Card code="01" title="Limits" note="How many workers run, how long they may take to start, and when they stop.">
        <div className="of-grid">
          <Field label="Most workers at once" hint="The others wait their turn. From 1 to 8.">
            <input type="number" min={1} max={8} value={office.maxConcurrent} onChange={(e) => onChange({ maxConcurrent: num(e.target.value) })} />
          </Field>
          <Field label="Start timeout (seconds)" hint="How long a worker may take to start before it is given up on. From 10 to 600.">
            <input type="number" min={10} max={600} value={office.startTimeoutSec} onChange={(e) => onChange({ startTimeoutSec: num(e.target.value) })} />
          </Field>
          <Field label="Pause at (% of the five-hour window)" hint="When your Claude subscription window is this full, workers wait until it resets. 0 means never pause.">
            <input type="number" min={0} max={100} value={Math.round(office.pauseAtWindow * 100)} onChange={(e) => onChange({ pauseAtWindow: Math.min(100, Math.max(0, num(e.target.value))) / 100 })} />
          </Field>
          <Field label="Limit per worker (tokens)" hint="A worker stops when it has used this many. 0 means no limit.">
            <input type="number" min={0} step={1000} value={office.budget.perWorkerTokens} onChange={(e) => onChange({ budget: { ...office.budget, perWorkerTokens: num(e.target.value) } })} />
          </Field>
          <Field label="Limit in total (tokens)" hint="All workers together. 0 means no limit.">
            <input type="number" min={0} step={1000} value={office.budget.totalTokens} onChange={(e) => onChange({ budget: { ...office.budget, totalTokens: num(e.target.value) } })} />
          </Field>
        </div>
      </Card>

      <Card code="02" title="Roles" note="A role is what a worker is for: its name and the instructions it always starts with. The id is how Friend refers to it.">
        {office.roles.map((r, i) => (
          <fieldset key={i} className="of-item">
            <legend>
              <span className="of-code">ROLE {pad(i + 1)}</span> {r.title || r.id || "new"}
            </legend>
            <div className="of-grid">
              <Field label="Id">
                <input aria-label={`Role ${i + 1} id`} value={r.id} maxLength={24} onChange={(e) => setRole(i, { id: e.target.value })} />
              </Field>
              <Field label="Title">
                <input aria-label={`Role ${i + 1} title`} value={r.title} maxLength={40} onChange={(e) => setRole(i, { title: e.target.value })} />
              </Field>
              <Field label="Model" hint="Empty: the model chosen under Model.">
                <input aria-label={`Role ${i + 1} model`} value={r.model} onChange={(e) => setRole(i, { model: e.target.value })} />
              </Field>
              <Field label="Edits" hint="Ask: every step asks unless your rules let it through. Accept edits: edits inside the project folder go ahead.">
                <select aria-label={`Role ${i + 1} permission`} value={r.permission} onChange={(e) => setRole(i, { permission: e.target.value as OfficeRole["permission"] })}>
                  <option value="default">Ask</option>
                  <option value="acceptEdits">Accept edits in the project folder</option>
                </select>
              </Field>
            </div>
            <Field label="Instructions" wide>
              <textarea aria-label={`Role ${i + 1} instructions`} rows={3} maxLength={4000} value={r.instructions} onChange={(e) => setRole(i, { instructions: e.target.value })} />
            </Field>
            <Problems list={roleProblems(office.roles, i)} />
            <button type="button" className="of-remove" aria-label={`Remove role ${i + 1}`} onClick={() => onChange({ roles: office.roles.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </fieldset>
        ))}
        <button type="button" className="of-add" onClick={() => onChange({ roles: [...office.roles, { id: "", title: "", instructions: "", model: "", permission: "default" }] })}>
          + Add a role
        </button>
      </Card>

      <Card code="03" title="Projects" note="A project is a folder workers may work in. A worker never goes outside it and its extra folders.">
        {office.projects.map((p, i) => (
          <fieldset key={i} className="of-item">
            <legend>
              <span className="of-code">PROJECT {pad(i + 1)}</span> {p.name || p.id || "new"}
            </legend>
            <div className="of-grid">
              <Field label="Id">
                <input aria-label={`Project ${i + 1} id`} value={p.id} maxLength={24} onChange={(e) => setProject(i, { id: e.target.value })} />
              </Field>
              <Field label="Name">
                <input aria-label={`Project ${i + 1} name`} value={p.name} maxLength={60} onChange={(e) => setProject(i, { name: e.target.value })} />
              </Field>
            </div>
            <Field label="Folder" wide>
              <input aria-label={`Project ${i + 1} folder`} value={p.folder} maxLength={260} onChange={(e) => setProject(i, { folder: e.target.value })} />
            </Field>
            <Field label="Goal" hint="One line workers are told about this project." wide>
              <input aria-label={`Project ${i + 1} goal`} value={p.goal} maxLength={500} onChange={(e) => setProject(i, { goal: e.target.value })} />
            </Field>
            <Field label="Extra folders (one per line)" hint="Up to five more folders workers may read and change." wide>
              <LinesArea label={`Project ${i + 1} extra folders`} rows={2} value={p.extraFolders} onChange={(v) => setProject(i, { extraFolders: v })} />
            </Field>
            <Problems list={projectProblems(office.projects, i)} />
            <button type="button" className="of-remove" aria-label={`Remove project ${i + 1}`} onClick={() => onChange({ projects: office.projects.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </fieldset>
        ))}
        <button type="button" className="of-add" onClick={() => onChange({ projects: [...office.projects, { id: "", name: "", folder: "", goal: "", extraFolders: [] }] })}>
          + Add a project
        </button>
      </Card>

      <Card code="04" title="Rules" note="What the gate does with a worker's request, before it ever reaches you.">
        <Field label="Let through without asking (one tool name per line)" hint="Claude Code tools a worker may use inside its folders without asking you, such as Read. Anything else asks." wide>
          <LinesArea rows={4} value={office.policy.allowTools} onChange={(v) => onChange({ policy: { ...office.policy, allowTools: v } })} />
        </Field>
        <Field label="Always refuse (one pattern per line)" hint="Commands that match one of these are refused, even if you would say yes. Each line is a regular expression, matched without regard to capital letters." wide>
          <LinesArea rows={4} value={patterns} onChange={(v) => onChange({ policy: { ...office.policy, denyCommands: v } })} />
        </Field>
        <Problems list={patternProblems(patterns)} />
      </Card>
    </div>
  );
}