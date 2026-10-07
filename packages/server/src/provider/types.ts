export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean };

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
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

export interface Provider {
  id: string;
  stream(req: StreamRequest): AsyncIterable<ProviderEvent>;
}
