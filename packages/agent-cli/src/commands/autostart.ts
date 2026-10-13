import { Autostart, currentSelf, realAutostartDeps, type AutostartResult, type AutostartStatus } from "@friend/server";
import type { IO } from "../cli";

const USAGE = "Usage: friend autostart on|off|status";

/** What the command needs; tests replace it. */
export interface AutostartLike {
  status(): Promise<AutostartStatus>;
  enable(): Promise<AutostartResult>;
  disable(): Promise<AutostartResult>;
  refresh(): Promise<void>;
}

const real = (io: IO): AutostartLike => new Autostart(realAutostartDeps(io.dataDir), currentSelf);

/** `friend autostart`: start Friend by itself when you sign in to this computer (Windows, macOS and Linux). */
export async function autostartCommand(args: string[], io: IO, autostart: AutostartLike = real(io)): Promise<number> {
  switch (args[0]) {
    case "on":
    case "off": {
      const r = await (args[0] === "on" ? autostart.enable() : autostart.disable());
      if (!r.ok) {
        io.err(r.message);
        return 1;
      }
      io.out(r.message);
      if (args[0] === "on") io.out("Turn it off again with: friend autostart off");
      return 0;
    }
    case "status": {
      const s = await autostart.status();
      if (!s.supported) {
        io.out("Starting Friend by itself is not supported on this kind of computer.");
        return 0;
      }
      io.out(`Starts by itself when you sign in: ${s.enabled ? "yes" : "no"}${s.enabled ? ` (${s.kind})` : ""}`);
      if (!s.enabled) io.out("Turn it on with: friend autostart on");
      return 0;
    }
    case "refresh":
      // run by an upgrade, so the setup points at the program that was just installed
      await autostart.refresh();
      return 0;
    default:
      io.err(USAGE);
      return 1;
  }
}
