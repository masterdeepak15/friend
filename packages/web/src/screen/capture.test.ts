import type { ClientMsg } from "@friend/protocol";
import { describe, expect, it, vi } from "vitest";
import { ScreenController, fitScreen } from "./capture";

const make = (capture: () => Promise<Blob>, upload = vi.fn(async () => {})) => {
  const sent: ClientMsg[] = [];
  const dispatch = vi.fn();
  const ctl = new ScreenController({ send: (m) => sent.push(m), upload, dispatch, capture });
  return { ctl, sent, upload, dispatch };
};
const jpeg = () => new Blob(["x"], { type: "image/jpeg" });

describe("fitScreen", () => {
  it("keeps the shape, never enlarges, and caps the longest side at 1600", () => {
    expect(fitScreen(3200, 1600)).toEqual({ width: 1600, height: 800 });
    expect(fitScreen(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe("ScreenController", () => {
  it("takes one picture when asked and uploads it under the request id", async () => {
    const { ctl, upload, sent } = make(async () => jpeg());
    await ctl.handle({ type: "screen.request", id: "r1" });
    expect(upload).toHaveBeenCalledWith("r1", expect.any(Blob));
    expect(sent).toEqual([]);
  });

  it("tells the server when the screen could not be drawn", async () => {
    const { ctl, sent, upload } = make(async () => {
      throw new Error("boom");
    });
    await ctl.handle({ type: "screen.request", id: "r1" });
    expect(sent).toEqual([{ type: "screen.denied", id: "r1", reason: "failed" }]);
    expect(upload).not.toHaveBeenCalled();
  });

  it("answers busy to a second request while one is running", async () => {
    let release: (b: Blob) => void = () => {};
    const { ctl, sent } = make(() => new Promise<Blob>((r) => (release = r)));
    const first = ctl.handle({ type: "screen.request", id: "r1" });
    await ctl.handle({ type: "screen.request", id: "r2" });
    expect(sent).toEqual([{ type: "screen.denied", id: "r2", reason: "busy" }]);
    release(jpeg());
    await first;
  });

  it("uploads nothing when the request was cancelled meanwhile", async () => {
    let release: (b: Blob) => void = () => {};
    const { ctl, upload } = make(() => new Promise<Blob>((r) => (release = r)));
    const running = ctl.handle({ type: "screen.request", id: "r1" });
    await ctl.handle({ type: "screen.cancel", id: "r1" });
    release(jpeg());
    await running;
    expect(upload).not.toHaveBeenCalled();
  });

  it("warns the owner when the upload fails", async () => {
    const { ctl, dispatch } = make(async () => jpeg(), vi.fn(async () => {
      throw new Error("down");
    }));
    await ctl.handle({ type: "screen.request", id: "r1" });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "alert.add" }));
  });
});
