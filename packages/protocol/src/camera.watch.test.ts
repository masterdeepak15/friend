import { describe, expect, it } from "vitest";
import { ServerMsg, TOOL_DEFS, describeCall } from "./index";

describe("camera.watch", () => {
  const def = TOOL_DEFS.find((t) => t.name === "camera.watch");

  it("is a tool of tier T2 that takes a short number of seconds and frames", () => {
    expect(def).toBeTruthy();
    expect(def!.baseTier).toBe("T2");
    expect(def!.input.safeParse({}).success).toBe(true);
    expect(def!.input.safeParse({ seconds: 5, frames: 6 }).success).toBe(true);
    expect(def!.input.safeParse({ seconds: 11 }).success).toBe(false);
    expect(def!.input.safeParse({ seconds: 0 }).success).toBe(false);
    expect(def!.input.safeParse({ frames: 13 }).success).toBe(false);
    expect(def!.input.safeParse({ frames: 1 }).success).toBe(false);
  });

  it("is described honestly on the approval card", () => {
    expect(describeCall("camera.watch", { seconds: 5, frames: 6 })).toMatch(/Watch through the camera for 5 seconds/);
    expect(describeCall("camera.watch", { seconds: 5, frames: 6 })).toMatch(/AI model/);
    expect(describeCall("camera.watch", {})).toMatch(/Watch through the camera/);
  });

  it("the camera request message may carry the number of frames and the seconds", () => {
    expect(ServerMsg.safeParse({ type: "camera.request", id: "r1" }).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "camera.request", id: "r1", frames: 6, seconds: 5 }).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "camera.request", id: "r1", frames: 99, seconds: 5 }).success).toBe(false);
  });
});
