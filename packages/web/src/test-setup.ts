import { afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";

afterEach(() => cleanup());

// the Jarvis component library is fetched on first use (a separate piece of the page): waiting for it may take longer than a second on a busy machine
configure({ asyncUtilTimeout: 8000 });

// jsdom has no canvas implementation; make getContext quietly report "unsupported".
HTMLCanvasElement.prototype.getContext = (() => null) as never;
if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
}
