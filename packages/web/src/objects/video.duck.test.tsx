import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageDuck } from "../audio/duck";
import { Video } from "./more";

const SRC = `/api/media/${"a".repeat(32)}`;

beforeEach(() => pageDuck.set(1, 0));
afterEach(() => {
  cleanup();
  pageDuck.set(1, 0);
  vi.restoreAllMocks();
});

describe("a video on the screen while someone talks", () => {
  it("is turned down, and comes back to the volume it had", () => {
    const { container } = render(<Video props={{ src: SRC }} />);
    const v = container.querySelector("video")!;
    v.volume = 0.8;
    v.dispatchEvent(new Event("volumechange")); // a browser says so when the viewer moves the slider
    act(() => pageDuck.set(0.5, 0));
    expect(v.volume).toBeCloseTo(0.4);
    act(() => pageDuck.set(1, 0));
    expect(v.volume).toBeCloseTo(0.8);
  });

  it("stops following when the video is taken off the screen", () => {
    const { container, unmount } = render(<Video props={{ src: SRC }} />);
    const v = container.querySelector("video")!;
    unmount();
    v.volume = 0.9;
    act(() => pageDuck.set(0.2, 0));
    expect(v.volume).toBe(0.9);
  });
});

describe("YouTube's own player on the screen while someone talks", () => {
  it("is opened so that it can be spoken to", () => {
    const { container } = render(<Video props={{ embed: "dQw4w9WgXcQ" }} />);
    const src = container.querySelector("iframe")!.getAttribute("src")!;
    expect(src.startsWith("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?")).toBe(true);
    expect(new URL(src).searchParams.get("enablejsapi")).toBe("1");
    expect(new URL(src).searchParams.get("autoplay")).toBe("1"); // what was there before is still there
  });

  it("is turned down and back by messages to the player", () => {
    const { container } = render(<Video props={{ embed: "dQw4w9WgXcQ" }} />);
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    act(() => pageDuck.set(0.5, 0));
    const sent = post.mock.calls.map((c) => JSON.parse(String(c[0])) as { func?: string; args?: number[] });
    expect(sent.some((m) => m.func === "setVolume" && m.args?.[0] === 50)).toBe(true);
    expect(post.mock.calls.every((c) => (c as unknown[])[1] === "https://www.youtube-nocookie.com")).toBe(true);
    act(() => pageDuck.set(1, 0));
    expect(post.mock.calls.map((c) => JSON.parse(String(c[0])) as { func?: string; args?: number[] }).some((m) => m.func === "setVolume" && m.args?.[0] === 100)).toBe(true);
  });
});
