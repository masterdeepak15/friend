import type { Tier, Trust } from "@friend/protocol";
import type { Config } from "../config";
import type { Db } from "../db";
import { RuleStore, type Matcher, type Rule } from "./rules";

/** Tools that touch the owner's privacy: no standing rule can ever skip the approval card. */
export const ASK_EVERY_TIME = new Set(["camera.snap"]);

/**
 * What a recognized person of the household (not the owner) may use: the weather and the screen's pictures. Nothing
 * that reads files, runs commands, uses the camera, changes settings or touches the owner's notes and schedule.
 */
export const MEMBER_TOOLS = new Set(["weather.get", "stage.scene", "stage.show", "stage.update", "stage.hide", "stage.presence", "stage.mood"]);

/** What a voice from a speaker device (Alexa) may do without asking: look things up, show them, and add a reminder. */
import { isNeverByVoice } from "../alexa/constants";

export const VOICE_TOOLS = new Set([
  "weather.get",
  "task.list",
  "task.add",
  "memory.search",
  "system.info",
  "portfolio.status",
  "portfolio.summary",
  "portfolio.holdings",
  "portfolio.positions",
  "portfolio.funds",
  "portfolio.orders",
  "reports.list",
  "stage.scene",
  "stage.show",
  "stage.update",
  "stage.hide",
  "stage.mood",
  "stage.presence",
]);

/** What the "edits" approval mode lets through without asking: reading and writing files, and the sandboxed code runner. */
const EDIT_TOOLS = new Set(["fs.list", "fs.read", "fs.write", "code.run"]);

/** Tools that widen what Friend can do (connectors, plugins). They always ask, in every approval mode. */
const isAdminTool = (tool: string) => tool.startsWith("connectors.") || tool.startsWith("plugins.") || tool.startsWith("integrations.");

export type Decision = "allow" | "ask" | "ask_with_pin" | "deny";

export interface DecideInput {
  tool: string;
  baseTier: Tier;
  args: unknown;
  trust: Trust;
  insideRoots: boolean;
  /** The path is inside Friend's own data folder (its database, settings and keys): no approval mode skips the question. */
  protectedPath?: boolean;
}

export class PolicyEngine {
  private rules: RuleStore;

  constructor(db: Db, private config: Config) {
    this.rules = new RuleStore(db);
  }

  /** Whether the approval mode lets this tool go ahead without a card. Risky (T3) actions never get here. */
  private modeAllows(tool: string, protectedPath: boolean | undefined): boolean {
    if (protectedPath || isAdminTool(tool)) return false;
    const mode = this.config.approvals;
    return mode === "auto" || (mode === "edits" && EDIT_TOOLS.has(tool));
  }

  decide(input: DecideInput): Decision {
    if (input.trust === "guest") return input.tool === "stage.presence" ? "allow" : "deny";
    if (input.trust === "member") return MEMBER_TOOLS.has(input.tool) ? "allow" : "deny";
    if (input.trust === "voice-device") {
      if (VOICE_TOOLS.has(input.tool)) return "allow";
      if (input.baseTier === "T3" || isNeverByVoice(input.tool)) return "deny";
      if (this.config.alexa.extraVoiceTools.includes(input.tool)) return "allow"; // a tool the owner chose to allow by voice
      if (input.baseTier === "T0" || input.baseTier === "T1") return "deny";
      return "ask"; // a tier-2 action: the owner says yes on their phone, whatever the approval mode
    }
    let tier: Tier = input.baseTier;
    if (!input.insideRoots && (tier === "T0" || tier === "T1")) tier = "T2";
    switch (tier) {
      case "T0":
      case "T1":
        return "allow";
      case "T2":
        if (ASK_EVERY_TIME.has(input.tool)) return "ask";
        if (this.rules.matches(input.tool, input.args)) return "allow";
        return this.modeAllows(input.tool, input.protectedPath) ? "allow" : "ask";
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
