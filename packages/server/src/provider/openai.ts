import { Agent, fetch as undiciFetch } from "undici";
import type { Msg, Provider, ProviderEvent, StreamRequest } from "./types";

export interface OpenAiOptions {
  /** Base URL that ends in /v1, for example http://localhost:20128/v1 (OmniRoute) or http://localhost:1234/v1 (LM Studio). */
  url: string;
  model: string;
  /** Sent as "Authorization: Bearer ...". Not every gateway asks for one. */
  apiKey?: string | null;
  /** The model can look at pictures. */
  vision?: boolean;
  /** Longest silence to wait for the model, in milliseconds. Unset or 0 means wait as long as it needs. */
  timeoutMs?: number;
}

// Function names may not contain dots ("fs.list" travels as "fs__list"), like with the other providers.
const encodeName = (n: string) => n.replaceAll(".", "__");
const decodeName = (n: string) => n.replaceAll("__", ".");

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Part[] }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export function toOpenAiMessages(system: string, messages: Msg[], vision: boolean): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n") });
    } else if (m.role === "assistant") {
      const text = m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const calls = m.content.filter((b) => b.type === "tool_use") as Extract<Msg["content"][number], { type: "tool_use" }>[];
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: encodeName(c.name), arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
      });
    } else {
      for (const b of m.content) if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.content });
      // A model that cannot see would only be confused by a picture, so it is sent only when the model can look.
      const pictures = vision ? m.content.flatMap((b) => (b.type === "image" ? [`data:${b.mime};base64,${b.data}`] : [])) : [];
      if (pictures.length) out.push({ role: "user", content: [{ type: "text", text: "Here is the picture from the camera." }, ...pictures.map((url) => ({ type: "image_url" as const, image_url: { url } }))] });
    }
  }
  return out;
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {}; // the agent loop turns invalid arguments into an error the model can read
  }
}

/**
 * Talks to any server that speaks the OpenAI chat API (POST {url}/chat/completions, streaming): OmniRoute, LM Studio,
 * vLLM, LiteLLM, OpenRouter and the like. Tool calls are supported.
 */
export class OpenAiProvider implements Provider {
  id = "openai";
  private agent: Agent;

  constructor(private opts: OpenAiOptions) {
    const limit = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
    this.agent = new Agent({ headersTimeout: limit, bodyTimeout: limit });
  }

  get vision(): boolean {
    return this.opts.vision === true;
  }

  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    const base = this.opts.url.replace(/\/+$/, "");
    const body = {
      model: this.opts.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        ...toOpenAiMessages(req.system, req.messages, this.vision),
        // last of all, so every message before it stays identical between requests and a gateway can reuse its cache of them
        ...(req.context ? [{ role: "user" as const, content: req.context }] : []),
      ],
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: encodeName(t.name), description: t.description, parameters: t.inputSchema } })) } : {}),
    };

    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: req.signal,
        dispatcher: this.agent,
      });
    } catch (e) {
      if (req.signal.aborted) return;
      const code = (e as { cause?: { code?: string } }).cause?.code ?? "";
      if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
        yield { type: "error", userFacing: true, message: "The model took too long to answer. Try again, or choose a faster model." };
        return;
      }
      yield { type: "error", userFacing: true, message: `I can't reach the model server at ${base}. Is it running? Check the address in Settings.` };
      return;
    }

    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { error?: { message?: string } | string };
        detail = typeof j.error === "string" ? j.error : (j.error?.message ?? "");
      } catch {
        /* no JSON body */
      }
      if (res.status === 401 || res.status === 403) yield { type: "error", userFacing: true, message: "The model server refused the API key. Check it in Settings." };
      else if (res.status === 404) yield { type: "error", userFacing: true, message: `The model server has no "${this.opts.model}", or the address is wrong (it should end in /v1). ${detail}`.trim() };
      else if (res.status === 429) yield { type: "error", userFacing: true, message: "The model server says too many requests or the limit is used up. Try again in a moment." };
      else yield { type: "error", message: `Model server error (${res.status})${detail ? `: ${detail}` : ""}` };
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: { input: number; output: number } | null = null;

    const flush = function* (): Generator<ProviderEvent> {
      for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        if (c.name) yield { type: "tool_call", id: c.id || `openai-${Date.now().toString(36)}-${c.name}`, name: decodeName(c.name), args: parseArgs(c.args) };
      }
      calls.clear();
    };

    const handle = function* (line: string): Generator<ProviderEvent> {
      const text = line.trim();
      if (!text.startsWith("data:")) return;
      const data = text.slice(5).trim();
      if (data === "[DONE]") {
        yield* flush();
        if (usage) yield { type: "usage", ...usage };
        yield { type: "done" };
        finished = true;
        return;
      }
      let obj: any;
      try {
        obj = JSON.parse(data);
      } catch {
        return;
      }
      if (obj.error) {
        yield { type: "error", message: `Model server error: ${typeof obj.error === "string" ? obj.error : (obj.error.message ?? "unknown")}` };
        finished = true;
        return;
      }
      if (obj.usage) usage = { input: obj.usage.prompt_tokens ?? 0, output: obj.usage.completion_tokens ?? 0 };
      for (const choice of obj.choices ?? []) {
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) yield { type: "text_delta", text: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          const i = typeof tc.index === "number" ? tc.index : 0;
          const cur = calls.get(i) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
          calls.set(i, cur);
        }
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
      if (!finished) {
        yield* flush();
        const u = usage as { input: number; output: number } | null; // set while reading, which the compiler cannot follow
        if (u) yield { type: "usage", input: u.input, output: u.output };
        yield { type: "done" };
      }
    } catch (e) {
      if (req.signal.aborted) return;
      yield { type: "error", message: `Lost the connection to the model server: ${(e as Error).message}` };
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}
