import type { Msg, Provider, ProviderEvent, StreamRequest } from "./types";

export interface OllamaOptions {
  /** Base URL of the Ollama server, e.g. http://127.0.0.1:11434 */
  url: string;
  model: string;
  /** Context window to request. Ollama's default (4096) is too small for the system prompt plus tool schemas. */
  contextTokens: number;
  keepAlive?: string;
  /** The model can look at pictures (for example llava or qwen2.5vl). */
  vision?: boolean;
}

// Tool names travel without dots ("fs.list" as "fs__list"), like with the Claude provider.
const encodeName = (n: string) => n.replaceAll(".", "__");
const decodeName = (n: string) => n.replaceAll("__", ".");

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
  images?: string[];
}

function toOllamaMessages(system: string, messages: Msg[], vision: boolean): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n") });
    } else if (m.role === "assistant") {
      const text = m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const calls = m.content.filter((b) => b.type === "tool_use") as Extract<Msg["content"][number], { type: "tool_use" }>[];
      for (const c of calls) nameById.set(c.id, encodeName(c.name));
      out.push({
        role: "assistant",
        content: text,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: encodeName(c.name), arguments: c.input } })) } : {}),
      });
    } else {
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        out.push({ role: "tool", content: b.content, tool_name: nameById.get(b.toolUseId) ?? "tool" });
      }
      // Ollama takes pictures on a user message; a model that cannot see would only be confused by them.
      const pictures = vision ? m.content.flatMap((b) => (b.type === "image" ? [b.data] : [])) : [];
      if (pictures.length) out.push({ role: "user", content: "Here is the picture from the camera.", images: pictures });
    }
  }
  return out;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {}; // the agent loop turns invalid arguments into an error the model can read
  }
}

let callCounter = 0;

/** Talks to a local Ollama server (native /api/chat streaming). Used for offline use and for testing without an API key. */
export class OllamaProvider implements Provider {
  id = "ollama";

  constructor(private opts: OllamaOptions) {}

  get vision(): boolean {
    return this.opts.vision === true;
  }

  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    const { url, model } = this.opts;
    const body = {
      model,
      stream: true,
      messages: toOllamaMessages(req.system, req.messages, this.vision),
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: encodeName(t.name), description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
      options: { num_ctx: this.opts.contextTokens },
      keep_alive: this.opts.keepAlive ?? "30m",
    };

    let res: Response;
    try {
      res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch {
      if (req.signal.aborted) return;
      yield { type: "error", userFacing: true, message: `I can't reach Ollama at ${url}. Is it running? Try: friend ollama status` };
      return;
    }

    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        /* no JSON body */
      }
      if (res.status === 404) {
        yield { type: "error", userFacing: true, message: `The model "${model}" is not installed in Ollama. Run: friend ollama setup ${model}` };
      } else if (/does not support tools/i.test(detail)) {
        yield {
          type: "error",
          userFacing: true,
          message: `The model "${model}" does not support tools, so I cannot act on your PC with it. Try: friend config set ollama.model qwen2.5:7b`,
        };
      } else {
        yield { type: "error", message: `Ollama error (${res.status})${detail ? `: ${detail}` : ""}` };
      }
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;

    const handle = function* (line: string): Generator<ProviderEvent> {
      if (!line.trim()) return;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      if (obj.error) {
        yield { type: "error", message: `Ollama error: ${obj.error}` };
        finished = true;
        return;
      }
      const content: string = obj.message?.content ?? "";
      if (content) yield { type: "text_delta", text: content };
      for (const call of obj.message?.tool_calls ?? []) {
        yield {
          type: "tool_call",
          id: `ollama-${Date.now().toString(36)}-${callCounter++}`,
          name: decodeName(String(call.function?.name ?? "")),
          args: parseArgs(call.function?.arguments),
        };
      }
      if (obj.done) {
        if (typeof obj.prompt_eval_count === "number" || typeof obj.eval_count === "number") {
          yield { type: "usage", input: obj.prompt_eval_count ?? 0, output: obj.eval_count ?? 0 };
        }
        yield { type: "done" };
        finished = true;
      }
    };

    try {
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while (!finished && (nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          yield* handle(line);
        }
      }
      if (!finished && buffer.trim()) yield* handle(buffer);
      if (!finished) yield { type: "done" };
    } catch (e) {
      if (req.signal.aborted) return;
      yield { type: "error", message: `Lost the connection to Ollama: ${(e as Error).message}` };
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}
