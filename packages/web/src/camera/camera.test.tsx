import type { ClientMsg, PendingApproval } from "@friend/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../overlay/ApprovalCard";
import { OwnerMenu } from "../overlay/OwnerMenu";
import { Overlay } from "../overlay/Overlay";
import { initialState, reduce, type LocalAction } from "../store";
import { CameraController, fitSize, reasonFor } from "./controller";
import { CameraIndicator } from "./CameraIndicator";

afterEach(cleanup);

function fakeStream() {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}
const blob = new Blob(["jpeg"], { type: "image/jpeg" });
const domError = (name: string) => Object.assign(new Error(name), { name });

function setup(over: Partial<ConstructorParameters<typeof CameraController>[0]> = {}) {
  const sent: ClientMsg[] = [];
  const actions: LocalAction[] = [];
  const cam = fakeStream();
  const opts = {
    send: (m: ClientMsg) => sent.push(m),
    upload: vi.fn(async () => {}),
    dispatch: (a: LocalAction) => actions.push(a),
    enabled: () => true,
    open: vi.fn(async () => cam.stream),
    frame: vi.fn(async () => blob),
    ...over,
  };
  return { ctl: new CameraController(opts), sent, actions, cam, opts };
}

describe("CameraController", () => {
  it("takes one picture, uploads it under the request id, and releases the camera", async () => {
    const { ctl, sent, actions, cam, opts } = setup();
    await ctl.handle({ type: "camera.request", id: "r1" });
    expect(opts.open).toHaveBeenCalledTimes(1);
    expect(opts.upload).toHaveBeenCalledWith("r1", blob);
    expect(cam.track.stop).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    expect(actions.map((a) => a.type)).toEqual(["camera.open", "camera.closed"]);
  });

  it("answers 'off' without ever opening the camera while the switch is off", async () => {
    const { ctl, sent, opts } = setup({ enabled: () => false });
    await ctl.handle({ type: "camera.request", id: "r1" });
    expect(sent).toEqual([{ type: "camera.denied", id: "r1", reason: "off" }]);
    expect(opts.open).not.toHaveBeenCalled();
    expect(opts.upload).not.toHaveBeenCalled();
  });

  it.each([
    ["NotAllowedError", "permission"],
    ["SecurityError", "permission"],
    ["NotFoundError", "no-camera"],
    ["OverconstrainedError", "no-camera"],
    ["NotReadableError", "busy"],
    ["SomethingElse", "busy"],
  ])("maps %s to the denial reason %s", async (name, reason) => {
    expect(reasonFor(domError(name))).toBe(reason);
    const { ctl, sent, actions } = setup({ open: vi.fn(async () => Promise.reject(domError(name))) });
    await ctl.handle({ type: "camera.request", id: "r1" });
    expect(sent).toEqual([{ type: "camera.denied", id: "r1", reason }]);
    expect(actions.at(-1)?.type).not.toBe("camera.open");
  });

  it("stops the camera when taking the picture fails", async () => {
    const { ctl, sent, cam } = setup({ frame: vi.fn(async () => Promise.reject(new Error("no frame"))) });
    await ctl.handle({ type: "camera.request", id: "r1" });
    expect(cam.track.stop).toHaveBeenCalled();
    expect(sent).toEqual([{ type: "camera.denied", id: "r1", reason: "busy" }]);
  });

  it("tells the owner when the picture could not be sent, and still releases the camera", async () => {
    const { ctl, actions, cam } = setup({ upload: vi.fn(async () => Promise.reject(new Error("offline"))) });
    await ctl.handle({ type: "camera.request", id: "r1" });
    expect(cam.track.stop).toHaveBeenCalled();
    expect(actions.some((a) => a.type === "alert.add")).toBe(true);
  });

  it("a cancel while the camera is still opening releases it and sends nothing", async () => {
    let release: (s: MediaStream) => void = () => {};
    const { ctl, sent, cam, opts } = setup({ open: vi.fn(() => new Promise<MediaStream>((r) => (release = r))) });
    const pending = ctl.handle({ type: "camera.request", id: "r1" });
    await ctl.handle({ type: "camera.cancel", id: "r1" });
    release(cam.stream);
    await pending;
    expect(cam.track.stop).toHaveBeenCalled();
    expect(opts.frame).not.toHaveBeenCalled();
    expect(opts.upload).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("a cancel during capture uploads nothing", async () => {
    let finish: (b: Blob) => void = () => {};
    const { ctl, cam, opts } = setup({ frame: vi.fn(() => new Promise<Blob>((r) => (finish = r))) });
    const pending = ctl.handle({ type: "camera.request", id: "r1" });
    await vi.waitFor(() => expect(opts.frame).toHaveBeenCalled());
    await ctl.handle({ type: "camera.cancel", id: "r1" });
    expect(cam.track.stop).toHaveBeenCalled();
    finish(blob);
    await pending;
    expect(opts.upload).not.toHaveBeenCalled();
  });

  it("ignores a cancel for a different request", async () => {
    const { ctl, opts } = setup();
    const pending = ctl.handle({ type: "camera.request", id: "r1" });
    await ctl.handle({ type: "camera.cancel", id: "other" });
    await pending;
    expect(opts.upload).toHaveBeenCalled();
  });

  it("is busy for a second request while one is running", async () => {
    let finish: (b: Blob) => void = () => {};
    const { ctl, sent } = setup({ frame: vi.fn(() => new Promise<Blob>((r) => (finish = r))) });
    const first = ctl.handle({ type: "camera.request", id: "r1" });
    await vi.waitFor(() => expect(finish).not.toBe(undefined));
    await ctl.handle({ type: "camera.request", id: "r2" });
    expect(sent).toEqual([{ type: "camera.denied", id: "r2", reason: "busy" }]);
    finish(blob);
    await first;
  });

  it("dispose releases a camera that is open", async () => {
    const { ctl, cam, opts } = setup({ frame: vi.fn(() => new Promise<Blob>(() => {})) });
    void ctl.handle({ type: "camera.request", id: "r1" });
    await vi.waitFor(() => expect(opts.frame).toHaveBeenCalled());
    ctl.dispose();
    expect(cam.track.stop).toHaveBeenCalled();
  });
});

describe("fitSize", () => {
  it("scales the longest side down to 1024 and keeps the shape", () => {
    expect(fitSize(1920, 1080)).toEqual({ width: 1024, height: 576 });
    expect(fitSize(1080, 1920)).toEqual({ width: 576, height: 1024 });
  });
  it("never enlarges a small picture", () => {
    expect(fitSize(640, 480)).toEqual({ width: 640, height: 480 });
  });
});

describe("camera in the store", () => {
  it("starts switched off and closed", () => {
    expect(initialState.camera).toEqual({ enabled: false, stream: null });
  });
  it("switches on and off, and holds the stream only while open", () => {
    const { stream } = fakeStream();
    let s = reduce(initialState, { type: "camera.enable", value: true });
    expect(s.camera.enabled).toBe(true);
    s = reduce(s, { type: "camera.open", stream });
    expect(s.camera.stream).toBe(stream);
    s = reduce(s, { type: "camera.closed" });
    expect(s.camera.stream).toBeNull();
    s = reduce(reduce(s, { type: "camera.open", stream }), { type: "camera.enable", value: false });
    expect(s.camera).toEqual({ enabled: false, stream: null }); // switching off also drops the preview
  });
  it("leaves the camera messages to the controller", () => {
    expect(reduce(initialState, { type: "camera.request", id: "r1" })).toBe(initialState);
  });
});

describe("<CameraIndicator>", () => {
  it("says the camera is on and shows what it sees", () => {
    const { stream } = fakeStream();
    render(<CameraIndicator stream={stream} />);
    expect(screen.getByRole("status").textContent).toMatch(/camera on/i);
    expect(document.querySelector("video")).not.toBeNull();
  });
  it("is only drawn by the overlay while the camera is open", () => {
    const base = { approval: null, alerts: [], connection: "open" as const, deviceOnline: true, voiceMode: "idle" as const, send: () => {}, dispatch: () => {} };
    const { rerender } = render(<Overlay {...base} cameraStream={null} />);
    expect(screen.queryByText(/camera on/i)).toBeNull();
    rerender(<Overlay {...base} cameraStream={fakeStream().stream} />);
    expect(screen.getByText(/camera on/i)).toBeTruthy();
  });
});

describe("owner switch", () => {
  it("shows the camera state and toggles it from the menu", async () => {
    const onToggleCamera = vi.fn();
    const { rerender } = render(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={() => {}} cameraOn={false} onToggleCamera={onToggleCamera} />);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: /camera: off/i }));
    expect(onToggleCamera).toHaveBeenCalled();
    rerender(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={() => {}} cameraOn onToggleCamera={onToggleCamera} />);
    expect(screen.getByRole("button", { name: /camera: on/i })).toBeTruthy();
  });
});

describe("approval card for the camera", () => {
  const ap: PendingApproval = { id: "a1", tool: "camera.snap", summary: "Take one picture with the camera and show it to the AI model", tier: "T2", needsPin: false };
  it("offers no 'Always allow'", () => {
    render(<ApprovalCard approval={ap} send={() => {}} />);
    expect(screen.queryByRole("button", { name: /always allow/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^approve$/i })).toBeTruthy();
  });
  it("still offers it for an ordinary T2 tool", () => {
    render(<ApprovalCard approval={{ ...ap, tool: "shell.run" }} send={() => {}} />);
    expect(screen.getByRole("button", { name: /always allow/i })).toBeTruthy();
  });
});
