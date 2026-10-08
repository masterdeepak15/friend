import { touch } from "../overlay/touch";
import type { SlashCommand } from "./commands";

/** Every / command with what it does, so nothing has to be remembered. */
export function HelpPanel({ commands, onClose }: { commands: SlashCommand[]; onClose: () => void }) {
  return (
    <div className="approval help glass" role="dialog" aria-label="Commands" style={{ pointerEvents: "auto" }}>
      <div className="approval-head">
        <span className="approval-title">Commands</span>
      </div>
      <p className="auth-note">Type / in the message bar to see these as you type. They run on this screen and never go to the AI. Anything else you type is a message to Friend.</p>
      <dl className="help-list">
        {commands.map((c) => (
          <div key={c.name} className="help-row">
            <dt>
              /{c.name}
              {c.usage && <i> {c.usage}</i>}
            </dt>
            <dd>{c.description}</dd>
          </div>
        ))}
      </dl>
      <div className="approval-actions">
        <button type="button" style={touch} className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
