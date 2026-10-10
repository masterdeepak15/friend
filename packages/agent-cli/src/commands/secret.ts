import { Audit, Auth, openDb } from "@friend/server";
import type { IO } from "../cli";

/**
 * `friend password` / `friend pin`: set a new sign-in password or PIN from this PC. Being at this PC is the proof, so the old
 * one is not asked (this is also the way back in when it is forgotten). Changing the password signs every browser out.
 */
export async function secretCommand(kind: "password" | "pin", io: IO): Promise<number> {
  const db = openDb(io.dataDir);
  try {
    const auth = new Auth(db, new Audit(db));
    if (!auth.hasOwner()) {
      io.err("There is no owner yet. Run: friend setup");
      return 1;
    }
    const label = kind === "password" ? "password" : "PIN";
    const first = await io.ask(`New ${label} (${kind === "password" ? "at least 8 characters" : "at least 6 digits"}): `, { hidden: true });
    const problem = Auth.checkNewSecrets(kind === "password" ? { newPassword: first } : { newPin: first });
    if (problem) {
      io.err(problem);
      return 1;
    }
    const again = await io.ask(`Type the new ${label} again: `, { hidden: true });
    if (again !== first) {
      io.err(`The two ${label}s are not the same. Nothing was changed.`);
      return 1;
    }
    await auth.resetSecrets(kind === "password" ? { newPassword: first } : { newPin: first });
    io.out(kind === "password" ? "Password changed. Every browser and phone has been signed out; sign in again with the new password." : "PIN changed.");
    return 0;
  } finally {
    db.close();
  }
}
