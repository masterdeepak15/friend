import type { Provider, ProviderEvent, StreamRequest } from "./types";

/** Scripted provider for tests: each stream() call replays the next script entry. */
export class FakeProvider implements Provider {
  id = "fake";
  calls: StreamRequest[] = [];
  private i = 0;

  constructor(private script: ProviderEvent[][]) {}

  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    this.calls.push(req);
    const events = this.script[this.i++];
    if (!events) {
      yield { type: "error", message: "FakeProvider script exhausted" };
      return;
    }
    for (const e of events) {
      if (req.signal.aborted) return;
      yield e;
    }
  }
}
