import { loadConfig } from "@friend/server";
import type { IO } from "../cli";
import { defaultOnboardDeps, type OnboardDeps } from "./onboard";
import { check, installPlan, installers, type PrereqId } from "./onboard/prereq";

const ALL: PrereqId[] = ["node", "python", "docker", "ollama", "claude", "port"];

/** Looks at everything Friend can use on this PC and says what works, what does not, and how to fix it. Changes nothing. */
export async function doctorCommand(io: IO, partial: Partial<OnboardDeps> = {}): Promise<number> {
  const deps: OnboardDeps = { ...defaultOnboardDeps(), ...partial };
  const cfg = loadConfig(io.dataDir);
  io.out("Checking this PC:");
  const have = await installers(deps);
  let requiredMissing = false;
  for (const id of ALL) {
    const c = await check(id, deps, { port: cfg.port, claudeCommand: cfg.claudeCode.command });
    io.out(`  ${c.ok ? "✓" : c.need === "required" ? "✗" : "·"} ${c.label.padEnd(12)} ${c.detail}`);
    if (!c.ok && c.id !== "port") {
      const plan = installPlan(id, deps.platform, have);
      const how = plan?.steps.length ? plan.steps.map((s) => [s.cmd, ...s.args].join(" ")).join(" && ") : plan?.manual;
      io.out(`      needed for ${c.unlocks}${how ? `. To fix: ${how}` : ""}`);
      if (c.need === "required") requiredMissing = true;
    }
    if (c.id === "claude" && c.ok && !c.signedIn) io.out("      sign in with: claude auth login");
  }
  io.out("");
  io.out(`Model: ${cfg.provider}   Address: ${cfg.bind}:${cfg.port}`);
  io.out("Set things up step by step with: friend onboard");
  return requiredMissing ? 1 : 0;
}
