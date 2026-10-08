import type { Tier, Trust } from "@friend/protocol";
import type { Config } from "../config";
import type { Db } from "../db";
import { RuleStore, type Matcher, type Rule } from "./rules";

/** Tools that touch the owner's privacy: no standing rule can ever skip the approval card. */
export const ASK_EVERY_TIME = new Set(["camera.snap"]);

export type Decision = "allow" | "ask" | "ask_with_pin" | "deny";

export interface DecideInput {
  tool: string;
  baseTier: Tier;
  args: unknown;
  trust: Trust;
  insideRoots: boolean;
}

export class PolicyEngine {
  private rules: RuleStore;

  constructor(db: Db, _config: Config) {
    this.rules = new RuleStore(db);
  }

  decide(input: DecideInput): Decision {
    if (input.trust === "guest") return input.tool === "stage.presence" ? "allow" : "deny";
    let tier: Tier = input.baseTier;
    if (!input.insideRoots && (tier === "T0" || tier === "T1")) tier = "T2";
    switch (tier) {
      case "T0":
      case "T1":
        return "allow";
      case "T2":
        if (ASK_EVERY_TIME.has(input.tool)) return "ask";
        return this.rules.matches(input.tool, input.args) ? "allow" : "ask";
      case "T3":
        return "ask_with_pin";
    }
  }

  addRule(tool: string, matcher: Matcher): number {
    return this.rules.add(tool, matcher);
  }
  listRules(): Rule[] {
    return this.rules.list();
  }
  removeRule(id: number): void {
    this.rules.remove(id);
  }
}
