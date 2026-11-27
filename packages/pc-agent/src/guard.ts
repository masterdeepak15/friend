import type { PcPermissions } from "@friend/protocol";

/** Windows the assistant never clicks or types into: password managers, the Windows prompts that ask for consent or credentials, and banks. */
const DENY_WINDOWS: RegExp[] = [/1password/i, /bitwarden/i, /keepass/i, /lastpass/i, /dashlane/i, /nordpass/i, /roboform/i, /\bkeeper\b/i, /user account control/i, /windows security/i, /credential/i, /\bbank(ing)?\b/i, /paypal/i];

/** Names of buttons and menu items that cannot be undone or spend money: the owner is asked first. */
const ASK_NAMES = /\b(delete|remove|uninstall|erase|format|wipe|factory reset|reset this pc|permanently|pay|pay now|purchase|buy|buy now|place order|confirm order|send money|transfer|wire|empty recycle bin|sign out of all)\b/i;

const safe = (pattern: string, text: string): boolean => {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false; // a pattern that is not valid is ignored
  }
};

export interface Touched {
  /** The kind of control, as UI Automation names it (Button, MenuItem, Edit...). */
  type: string;
  name: string;
  /** The title of the window the control is in. */
  window: string;
}

export type ElementVerdict = { decision: "allow" } | { decision: "deny"; reason: string } | { decision: "ask"; reason: string; detail: string };

/** Whether the window is one the assistant must not use. */
export function offLimits(windowTitle: string, perms: PcPermissions): string | null {
  const hit = [...DENY_WINDOWS.map((r) => r.test(windowTitle)), ...(perms.denyWindows ?? []).map((p) => safe(p, windowTitle))].some(Boolean);
  return hit ? `The window "${windowTitle.slice(0, 80)}" is off limits (a password manager, a consent or credentials prompt, or a bank). The owner has to do this step themselves.` : null;
}

/** What to do about touching one control: refuse inside an off-limits window, ask when its name says it cannot be undone, otherwise go on. */
export function elementVerdict(t: Touched, perms: PcPermissions, approved: boolean): ElementVerdict {
  const blocked = offLimits(t.window, perms);
  if (blocked) return { decision: "deny", reason: blocked };
  if (approved) return { decision: "allow" };
  const asks = ASK_NAMES.test(t.name) || (perms.askPatterns ?? []).some((p) => safe(p, t.name));
  return asks ? { decision: "ask", reason: `A ${t.type.toLowerCase() || "control"} called "${t.name.slice(0, 80)}"`, detail: `${t.window.slice(0, 100)}: ${t.name.slice(0, 200)}` } : { decision: "allow" };
}
