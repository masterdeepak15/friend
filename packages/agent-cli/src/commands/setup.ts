import { Audit, Auth, loadConfig, openDb, saveConfig } from "@friend/server";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveVoice } from "@friend/protocol";
import type { IO } from "../cli";

export async function setupCommand(io: IO): Promise<number> {
  const db = openDb(io.dataDir);
  try {
    const auth = new Auth(db, new Audit(db));
    if (auth.hasOwner()) {
      io.err("An owner already exists for this Friend. Setup can only run once.");
      return 1;
    }
    io.out("Let's set up your Friend.");
    const password = await io.ask("Choose a password (at least 8 characters): ", { hidden: true });
    const pin = await io.ask("Choose a PIN for risky actions (at least 6 digits): ", { hidden: true });
    const assistantName = (await io.ask("What should your assistant be called? ")).trim() || "Friend";
    const workspace = (await io.ask("Workspace folder Friend may work in freely (blank to skip): ")).trim();
    const apiKey = (await io.ask("Anthropic API key (blank to add later): ", { hidden: true })).trim();
    const voiceAnswer = (await io.ask("Assistant voice, female or male (blank for the default; see all with: friend voice list): ")).trim();

    try {
      await auth.setupOwner({ password, pin, assistantName });
    } catch (e) {
      io.err((e as Error).message);
      return 1;
    }

    const cfg = loadConfig(io.dataDir);
    if (workspace) {
      const abs = resolve(workspace);
      mkdirSync(abs, { recursive: true });
      cfg.roots = [abs];
    }
    if (apiKey) cfg.apiKey = apiKey;
    if (voiceAnswer) {
      const v = resolveVoice(voiceAnswer);
      if (v) cfg.voice.ttsVoice = v.id;
      else io.out(`"${voiceAnswer}" is not a voice I know, so the default stays. See the list with: friend voice list`);
    }
    saveConfig(cfg);
    io.out(`Done. ${assistantName} is ready. Start it with: friend start`);
    return 0;
  } finally {
    db.close();
  }
}
