import Anthropic from "@anthropic-ai/sdk";
import type { Msg, Provider, ProviderEvent, StreamRequest } from "./types";

// Anthropic tool names may not contain dots, so "fs.list" travels as "fs__list".
const encodeName = (n: string) => n.replaceAll(".", "__");
const decodeName = (n: string) => n.replaceAll("__", ".");

interface MessagesClient {
  messages: { create(params: unknown, opts?: unknown): Promise<AsyncIterable<any>> };
}

export interface ClaudeOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
  client?: MessagesClient;
}

function toAnthropicMessages(messages: Msg[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "user",
        content: m.content
          .filter((b) => b.type === "tool_result")
          .map((b) => ({
            type: "tool_result",
            tool_use_id: (b as { toolUseId: string }).toolUseId,
            content: (b as { content: string }).content,
            is_error: (b as { isError: boolean }).isError,
          })),
      };
    }
    return {
      role: m.role,
      content: m.content.map((b) =>
        b.type === "tool_use" ? { type: "tool_use", id: b.id, name: encodeName(b.name), input: b.input } : b,
      ),
    };
  });
}

export class ClaudeProvider implements Provider {
  id = "claude";
  private client: MessagesClient;
  private model: string;
  private maxTokens: number;

  constructor(opts: ClaudeOptions) {
    if (!opts.apiKey && !opts.client) {
      throw new Error("No Anthropic API key configured. Run: friend config set apiKey <key>");
    }
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 4096;
    this.client = opts.client ?? (new Anthropic({ apiKey: opts.apiKey }) as unknown as MessagesClient);
  }

  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    const tools = new Map<number, { id: string; name: string; json: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const events = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: req.system,
          stream: true,
          messages: toAnthropicMessages(req.messages),
          tools: req.tools.map((t) => ({ name: encodeName(t.name), description: t.description, input_schema: t.inputSchema })),
        },
        { signal: req.signal },
      );
      for await (const ev of events) {
        if (req.signal.aborted) return;
        switch (ev.type) {
          case "message_start":
            inputTokens = ev.message?.usage?.input_tokens ?? 0;
            break;
          case "content_block_start":
            if (ev.content_block?.type === "tool_use") {
              tools.set(ev.index, { id: ev.content_block.id, name: decodeName(ev.content_block.name), json: "" });
            }
            break;
          case "content_block_delta":
            if (ev.delta?.type === "text_delta") yield { type: "text_delta", text: ev.delta.text };
            else if (ev.delta?.type === "input_json_delta") {
              const t = tools.get(ev.index);
              if (t) t.json += ev.delta.partial_json;
            }
            break;
          case "content_block_stop": {
            const t = tools.get(ev.index);
            if (t) {
              tools.delete(ev.index);
              let args: unknown = {};
              try {
                args = t.json ? JSON.parse(t.json) : {};
              } catch {
                yield { type: "error", message: `Model sent invalid arguments for ${t.name}` };
                return;
              }
              yield { type: "tool_call", id: t.id, name: t.name, args };
            }
            break;
          }
          case "message_delta":
            outputTokens = ev.usage?.output_tokens ?? outputTokens;
            break;
          case "message_stop":
            yield { type: "usage", input: inputTokens, output: outputTokens };
            yield { type: "done" };
            return;
        }
      }
    } catch (e) {
      if (req.signal.aborted) return;
      yield { type: "error", message: (e as Error).message };
    }
  }
}
