import type { Provider, ProviderEvent, StreamRequest } from "./types";

/** Lets the model backend be changed while Friend runs (from the settings screen) without touching anything that uses it. */
export class SwitchableProvider implements Provider {
  constructor(private current: Provider) {}

  get id(): string {
    return this.current.id;
  }

  get vision(): boolean | undefined {
    return this.current.vision;
  }

  stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    return this.current.stream(req);
  }

  /** Puts a new backend in place and returns the old one, which the caller closes. */
  swap(next: Provider): Provider {
    const old = this.current;
    this.current = next;
    return old;
  }

  async close(): Promise<void> {
    await this.current.close?.();
  }
}
