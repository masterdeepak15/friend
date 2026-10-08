import type { Slash, SlashCommand } from "./commands";
import { runSlash } from "./commands";

export interface CommandDeps {
  notify: (text: string) => void;
  openSettings: () => void;
  openPlugins: () => void;
  /** Null when speech is not available on this PC. */
  openVoice: (() => void) | null;
  muted: boolean;
  setMuted: (muted: boolean) => void;
  cameraOn: boolean;
  setCamera: (on: boolean) => void;
  /** Takes every object off the screen. */
  clearScreen: () => void;
  /** One plain line about what Friend is doing. */
  statusLine: () => string;
  /** Ends the session on the server ("logout") or locks everything ("lock"), then returns to the sign-in screen. */
  endSession: (how: "logout" | "lock") => void;
}

/** The commands the owner can type in the message bar. Each one runs here and never reaches the AI. */
export function buildCommands(d: CommandDeps): SlashCommand[] {
  const list: SlashCommand[] = [
    { name: "settings", description: "Open the settings (model, voice, …)", run: d.openSettings },
    { name: "plugins", description: "Add, switch or remove plugins", run: d.openPlugins },
    {
      name: "voice",
      description: "Teach Friend your voice",
      run: () => (d.openVoice ? d.openVoice() : d.notify("Speech is not set up. Run: friend voice setup")),
    },
    {
      name: "camera",
      usage: "on|off",
      description: "Switch the camera on or off (it only takes a picture when you approve)",
      run: (a) => {
        const want = a === "on" ? true : a === "off" ? false : !d.cameraOn;
        if (a && a !== "on" && a !== "off") return d.notify("Use /camera on or /camera off.");
        d.setCamera(want);
        d.notify(want ? "Camera switched on." : "Camera switched off.");
      },
    },
    {
      name: "mute",
      description: "Hide everything on the stage (/unmute shows it again)",
      run: () => d.setMuted(true),
    },
    { name: "unmute", description: "Show the stage again", run: () => d.setMuted(false) },
    { name: "clear", description: "Take everything off the screen", run: d.clearScreen },
    { name: "status", description: "What Friend is doing right now", run: () => d.notify(d.statusLine()) },
    { name: "logout", description: "Sign out", run: () => d.endSession("logout") },
    { name: "lock", description: "Emergency lock: end every session and stop the agent", run: () => d.endSession("lock") },
  ];
  list.push({
    name: "help",
    description: "List the commands",
    run: () => d.notify(`Commands: ${list.map((c) => `/${c.name}${c.usage ? ` ${c.usage}` : ""}`).join(", ")}. Anything else goes to Friend.`),
  });
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildSlash(d: CommandDeps): Slash {
  const commands = buildCommands(d);
  return { commands, run: (text) => runSlash(commands, text, d.notify) };
}
