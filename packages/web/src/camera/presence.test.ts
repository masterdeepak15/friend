import type { ClientMsg } from "@friend/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce, type LocalAction } from "../store";
import { PresenceWatcher } from "./presence";

function fakeStream() {
  const stops: number[] = [];
  const track = { stop: () => stops.push(1) };
  const stream = { getTracks: () => [track], clone: () => fakeStream().stream } as unknown as MediaStream;
  return { stream, stops };
}

function rig(over: { faces?: (j: Blob) => Promise<number[][]>; visible?: () => boolean; open?: () => Promise<MediaStream> } = {}) {
  const sent: ClientMsg[] = [];
  const actions: LocalAction[] = [];
  const s = fakeStream();
  const w = new PresenceWatcher({
    send: (m) => sent.push(m),
    dispatch: (a) => actions.push(a),
    faces: over.faces ?? (async () => [Array(128).fill(0.1)]),
    open: over.open ?? (async () => s.stream),
    frame: async () => new Blob(["x"]),
    visible: over.visible ?? (() => true),
    everyMs: 1000,
    retryMs: 5000,
  });
  return { w, sent, actions, s };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("PresenceWatcher", () => {
  it("opens the camera, shows it is open, and sends the face numbers every few seconds, never a picture", async () => {
    const r = rig();
    r.w.start();
    await flush();
    expect(r.actions).toContainEqual({ type: "camera.watch", stream: r.s.stream });
    expect(r.sent).toEqual([{ type: "presence.faces", faces: [Array(128).fill(0.1)] }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.sent).toHaveLength(2);
    expect(JSON.stringify(r.sent)).not.toMatch(/image|jpeg|blob/i);
  });

  it("closes the camera and says so as soon as it is stopped", async () => {
    const r = rig();
    r.w.start();
    await flush();
    r.w.stop();
    expect(r.s.stops).toHaveLength(1);
    expect(r.actions.at(-1)).toEqual({ type: "camera.watch", stream: null });
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.sent).toHaveLength(1); // nothing more after it stopped
  });

  it("closes the camera while the page is hidden and opens it again when it shows", async () => {
    let shown = true;
    const r = rig({ visible: () => shown });
    r.w.start();
    await flush();
    shown = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.s.stops).toHaveLength(1);
    expect(r.w.lend()).toBeNull();
    shown = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.actions.filter((a) => a.type === "camera.watch" && a.stream).length).toBe(2);
  });

  it("keeps quiet about an empty room, apart from now and then so the server knows it is still looking", async () => {
    const r = rig({ faces: async () => [] });
    r.w.start();
    await flush();
    expect(r.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(r.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.sent.length).toBeGreaterThanOrEqual(2);
  });

  it("tries again later, quietly, when the camera cannot be opened", async () => {
    let tries = 0;
    const r = rig({
      open: async () => {
        tries++;
        throw Object.assign(new Error("no"), { name: "NotAllowedError" });
      },
    });
    r.w.start();
    await flush();
    expect(tries).toBe(1);
    expect(r.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tries).toBe(2);
  });

  it("lends a copy of its stream, so a look the owner asked for can end its own copy without ending the watching", async () => {
    const r = rig();
    r.w.start();
    await flush();
    const loan = r.w.lend();
    expect(loan).not.toBeNull();
    expect(loan).not.toBe(r.s.stream);
  });
});

describe("the screen's state", () => {
  it("starts with the camera on and the eye unknown, learns the eye from the status, and shows the watching stream", () => {
    expect(initialState.camera).toMatchObject({ enabled: true, eyeOn: false, watching: null });
    let s = reduce(initialState, { type: "status", busy: false, deviceOnline: true, eyeOn: true });
    expect(s.camera.eyeOn).toBe(true);
    s = reduce(s, { type: "status", busy: false, deviceOnline: true });
    expect(s.camera.eyeOn).toBe(true); // a status without the news changes nothing
    const { stream } = fakeStream();
    s = reduce(s, { type: "camera.watch", stream });
    expect(s.camera.watching).toBe(stream);
  });
});
