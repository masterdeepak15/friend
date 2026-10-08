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
  | { type: "usage"; input: number; output: number }
  | { type: "done" }
  | { type: "error"; message: string; userFacing?: boolean };

export interface StreamRequest {
  /** What stays the same from request to request. Keep it stable so a model can reuse its cached work on it. */
  system: string;
  /** What changes every request (the clock, the screen). Providers send it as the very last message. */
  context?: string;
  messages: Msg[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

export interface Provider {
  id: string;
  /** Whether the model can look at pictures. Absent means no. */
  readonly vision?: boolean;
  stream(req: StreamRequest): AsyncIterable<ProviderEvent>;
}
