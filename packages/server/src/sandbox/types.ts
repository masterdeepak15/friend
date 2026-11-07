export type SandboxLanguage = "python" | "node" | "shell";

export interface SandboxInput {
  language: SandboxLanguage;
  code: string;
  /** Extra files the program can read, by plain name. They live in memory only. */
  files: Record<string, string>;
  timeoutMs: number;
}

export interface SandboxResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outOfMemory: boolean;
}

/** The engine for this language could not be started here. The message says what to do. */
export class SandboxUnavailable extends Error {}

/** More output than this is cut off and the program is stopped. */
export const MAX_SANDBOX_OUTPUT = 40_000;
/** The most memory a program may use, in megabytes. */
export const SANDBOX_MEMORY_MB = 512;
