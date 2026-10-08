import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Feature = "claude-code" | "claude-api" | "ollama" | "voice" | "sandbox";
export const FEATURES: Feature[] = ["claude-code", "claude-api", "ollama", "voice", "sandbox"];

/** What the wizard remembers, so running it again carries on where it stopped instead of asking everything twice. */
export interface OnboardState {
  version: 1;
  /** Steps that are finished, with when. */
  done: Record<string, string>;
  /** What the person said they want to use. */
  features: Feature[];
  /** Things that were installed but are not visible to this terminal yet. */
  restart: string[];
}

export const emptyState = (): OnboardState => ({ version: 1, done: {}, features: [], restart: [] });

export const statePath = (dataDir: string): string => join(dataDir, "onboarding.json");

export function loadState(dataDir: string): OnboardState {
  const f = statePath(dataDir);
  if (!existsSync(f)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(f, "utf8")) as Partial<OnboardState>;
    const done = raw.done && typeof raw.done === "object" ? Object.fromEntries(Object.entries(raw.done).filter(([, v]) => typeof v === "string")) : {};
    const features = Array.isArray(raw.features) ? raw.features.filter((x): x is Feature => FEATURES.includes(x as Feature)) : [];
    const restart = Array.isArray(raw.restart) ? raw.restart.filter((x): x is string => typeof x === "string") : [];
    return { version: 1, done, features, restart };
  } catch {
    return emptyState(); // a damaged file just means starting again
  }
}

export function saveState(dataDir: string, state: OnboardState): void {
  const f = statePath(dataDir);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, f);
}

export function resetState(dataDir: string): void {
  rmSync(statePath(dataDir), { force: true });
}
