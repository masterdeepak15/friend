export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  /** A picture for the model to look at in this turn only (base64). It is never stored. */
  | { type: "image"; mime: string; data: string };

export interface Msg {
  role: "user" | "assistant" | "tool";
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  /** `context` is how much the model read for its last call: the size of the conversation it keeps (when the provider knows). */
  | { type: "usage"; input: number; output: number; context?: number }
  | { type: "done" }
  | { type: "error"; message: string; userFacing?: boolean };

export interface StreamRequest {
  /** What stays the same from request to request. Keep it stable so a model can reuse its cached work on it. */
  system: string;
  /** What changes every request (the clock, the screen). Providers send it as the very last message. */
  context?: string;
  /** Whose conversation this is. A provider that keeps a session of its own must keep guests out of the owner's. */
  session?: "owner" | "guest";
  messages: Msg[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

export interface Provider {
  id: string;
  /** Whether the model can look at pictures. Absent means no. */
  readonly vision?: boolean;
  stream(req: StreamRequest): AsyncIterable<ProviderEvent>;
  /** Releases anything the provider keeps running (a background process, a local server). */
  close?(): Promise<void>;
  /** Forgets the owner's conversation that the provider keeps itself, and starts the next one from `seed` (a short summary) or from nothing. */
  resetSession?(seed?: string): Promise<void>;
}
