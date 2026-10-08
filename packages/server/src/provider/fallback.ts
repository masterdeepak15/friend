import type { Provider, ProviderEvent, StreamRequest } from "./types";

const NOTICE_EVERY_MS = 10 * 60_000;

/**
 * Tries the main provider; if it fails before it has said or done anything (not installed, signed out, a plan limit),
 * the same request goes to the other one, so Friend keeps working. A failure part-way through an answer is passed on as
 * it is, because the half answer cannot be taken back. An answer to a tool call goes to whoever made the call.
 */
export class FallbackProvider implements Provider {
  readonly id: string;
  private lastNotice = -Infinity;

  constructor(
    private primary: Provider,
    private other: Provider,
    /** Told why the main provider was skipped (at most once every ten minutes). */
    private onFallback: (reason: string) => void,
    private now: () => number = Date.now,
  ) {
    this.id = `${primary.id}+${other.id}`;
  }

  get vision(): boolean | undefined {
    return this.primary.vision;
  }

  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent> {
    if (this.answersCallOf(this.other, req)) {
      yield* this.other.stream(req);
      return;
    }
    let started = false;
    for await (const ev of this.primary.stream(req)) {
      if (ev.type === "error" && !started && !this.answersCallOf(this.primary, req)) {
        this.tell(ev.message);
        yield* this.other.stream(req);
        return;
      }
      if (ev.type === "text_delta" || ev.type === "tool_call") started = true;
      yield ev;
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close?.(), this.other.close?.()]);
  }

  private tell(reason: string): void {
    if (this.now() - this.lastNotice < NOTICE_EVERY_MS) return;
    this.lastNotice = this.now();
    this.onFallback(reason);
  }

  /** The request ends with the results of tool calls that this provider made (its ids), so only it can continue them. */
  private answersCallOf(provider: Provider, req: StreamRequest): boolean {
    const last = req.messages.at(-1);
    if (!last || last.role !== "tool") return false;
    const prefix = provider === this.primary ? "cc-" : "ollama-";
    const ids = last.content.flatMap((b) => (b.type === "tool_result" ? [b.toolUseId] : []));
    return ids.length > 0 && ids.every((id) => id.startsWith(prefix));
  }
}
