import type { ClientMsg } from "@friend/protocol";
import { describe, expect, it, vi } from "vitest";
import type { LocalAction } from "../store";
import { CameraController } from "./controller";

const blobN = (n: number) => new Blob([`jpeg${n}`], { type: "image/jpeg" });
function setup(over: Partial<ConstructorParameters<typeof CameraController>[0]> = {}) {
  const sent: ClientMsg[] = [];
  const actions: LocalAction[] = [];
  const order: string[] = [];
  const track = { stop: vi.fn(() => void order.push("released")) };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const upload = vi.fn(async (_id: string, _jpeg: Blob) => void order.push("upload"));
  const opts = {
    send: (m: ClientMsg) => sent.push(m),
    upload,
    dispatch: (a: LocalAction) => actions.push(a),
    enabled: () => true,
    open: vi.fn(async () => stream),
    frame: vi.fn(async () => blobN(0)),
    frames: vi.fn(async (_s: MediaStream, count: number, _seconds: number) => {
      order.push("captured");
      return Array.from({ length: count }, (_, i) => blobN(i));
    }),
    ...over,
  };
  return { ctl: new CameraController(opts), sent, actions, track, opts: { ...opts, upload }, order };
}

describe("CameraController with a short clip", () => {
  it("opens the camera once, takes all the frames, lets the camera go, then uploads them in order", async () => {
    const { ctl, opts, track, actions, order } = setup();
    await ctl.handle({ type: "camera.request", id: "r1", frames: 3, seconds: 2 });
    expect(opts.open).toHaveBeenCalledTimes(1);
    expect(opts.frames).toHaveBeenCalledWith(expect.anything(), 3, 2);
    expect(opts.upload).toHaveBeenCalledTimes(3);
    expect(opts.upload.mock.calls.map((c: unknown[]) => c[0])).toEqual(["r1", "r1", "r1"]);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(order.indexOf("released")).toBeLessThan(order.indexOf("upload")); // the camera is off before anything is sent
    expect(actions.map((a) => a.type)).toEqual(["camera.open", "camera.closed", "camera.still"]);
  });

  it("never takes more than 12 frames or 10 seconds, whatever it is asked", async () => {
    const { ctl, opts } = setup();
    await ctl.handle({ type: "camera.request", id: "r1", frames: 500, seconds: 600 });
    expect(opts.frames).toHaveBeenCalledWith(expect.anything(), 12, 10);
  });

  it("a plain request still takes one picture the old way", async () => {
    const { ctl, opts } = setup();
    await ctl.handle({ type: "camera.request", id: "r1" });
    expect(opts.frame).toHaveBeenCalledTimes(1);
    expect(opts.frames).not.toHaveBeenCalled();
    expect(opts.upload).toHaveBeenCalledTimes(1);
  });

  it("lets the camera go and says 'in use' when taking the frames fails", async () => {
    const { ctl, sent, track } = setup({ frames: vi.fn(async () => Promise.reject(new Error("no frames"))) });
    await ctl.handle({ type: "camera.request", id: "r1", frames: 3, seconds: 2 });
    expect(track.stop).toHaveBeenCalled();
    expect(sent).toEqual([{ type: "camera.denied", id: "r1", reason: "busy" }]);
  });

  it("answers 'off' without opening the camera while the switch is off", async () => {
    const { ctl, sent, opts } = setup({ enabled: () => false });
    await ctl.handle({ type: "camera.request", id: "r1", frames: 3, seconds: 2 });
    expect(sent).toEqual([{ type: "camera.denied", id: "r1", reason: "off" }]);
    expect(opts.open).not.toHaveBeenCalled();
  });
});

describe("CameraController finding faces", () => {
  const face = Array.from({ length: 128 }, (_, i) => i / 128);
  it("when asked to recognise: the camera goes off first, then the faces are found and sent, then the picture", async () => {
    const order: string[] = [];
    const faces = vi.fn(async (_b: Blob) => (order.push("found"), [face]));
    const sendFaces = vi.fn(async (_id: string, _f: number[][]) => void order.push("sent faces"));
    const { ctl, opts, track } = setup({ faces, sendFaces, upload: vi.fn(async () => void order.push("upload")) });
    track.stop.mockImplementation(() => void order.push("released"));
    await ctl.handle({ type: "camera.request", id: "r1", recognise: true });
    expect(order).toEqual(["released", "found", "sent faces", "upload"]);
    expect(sendFaces).toHaveBeenCalledWith("r1", [face]);
    expect(opts.frame).toHaveBeenCalledTimes(1);
  });

  it("looks for faces in the middle frame of a clip", async () => {
    const seen: string[] = [];
    const faces = vi.fn(async (b: Blob) => (seen.push(await b.text()), [face]));
    const { ctl } = setup({ faces, sendFaces: vi.fn(async () => {}) });
    await ctl.handle({ type: "camera.request", id: "r1", frames: 5, seconds: 2, recognise: true });
    expect(seen).toEqual(["jpeg2"]);
  });

  it("does nothing about faces when not asked", async () => {
    const faces = vi.fn(async () => [face]);
    const sendFaces = vi.fn(async () => {});
    const { ctl, opts } = setup({ faces, sendFaces });
    await ctl.handle({ type: "camera.request", id: "r1" });
    expect(faces).not.toHaveBeenCalled();
    expect(sendFaces).not.toHaveBeenCalled();
    expect(opts.upload).toHaveBeenCalledTimes(1);
  });

  it("a failure to find faces never stops the picture from being sent", async () => {
    const { ctl, opts } = setup({ faces: vi.fn(async () => Promise.reject(new Error("model broke"))), sendFaces: vi.fn(async () => {}) });
    await ctl.handle({ type: "camera.request", id: "r1", recognise: true });
    expect(opts.upload).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when no face was found", async () => {
    const sendFaces = vi.fn(async () => {});
    const { ctl } = setup({ faces: vi.fn(async () => []), sendFaces });
    await ctl.handle({ type: "camera.request", id: "r1", recognise: true });
    expect(sendFaces).not.toHaveBeenCalled();
  });
});
