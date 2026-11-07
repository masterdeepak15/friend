import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientMsg } from "@friend/protocol";
import { initialState, reduce, type LocalAction } from "../store";
import { CameraIndicator } from "./CameraIndicator";
import { CameraController } from "./controller";

const stream = () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream;
function setup(over: Partial<ConstructorParameters<typeof CameraController>[0]> = {}) {
  const actions: LocalAction[] = [];
  const revoked: string[] = [];
  const opts = {
    send: (_m: ClientMsg) => {},
    upload: vi.fn(async () => {}),
    dispatch: (a: LocalAction) => actions.push(a),
    enabled: () => true,
    open: async () => stream(),
    frame: async () => new Blob(["j"], { type: "image/jpeg" }),
    still: () => "blob:picture",
    release: (u: string) => void revoked.push(u),
    holdMs: 5000,
    ...over,
  };
  return { ctl: new CameraController(opts), actions, revoked };
}
const stills = (a: LocalAction[]) => a.filter((x) => x.type === "camera.still" || x.type === "camera.still.clear").map((x) => (x.type === "camera.still" ? `${x.note}` : "clear"));

afterEach(() => vi.useRealTimers());

describe("the picture the camera view keeps after a look", () => {
  it("is kept in the state and cleared again, and switching the camera off clears it too", () => {
    let s = reduce(initialState, { type: "camera.still", url: "blob:p", note: "1 face found" });
    expect(s.camera.still).toEqual({ url: "blob:p", note: "1 face found" });
    expect(reduce(s, { type: "camera.still.clear" }).camera.still).toBeFalsy();
    s = reduce(s, { type: "camera.enable", value: false });
    expect(s.camera.still).toBeFalsy();
  });

  it("is shown by the camera view with what was found, and the live picture wins while the camera is open", () => {
    const { rerender } = render(<CameraIndicator stream={null} still={{ url: "blob:p", note: "No face found" }} />);
    expect(screen.getByRole("status").textContent).toContain("No face found");
    expect(screen.getByRole("img").getAttribute("src")).toBe("blob:p");
    rerender(<CameraIndicator stream={stream()} still={null} />);
    expect(screen.getByRole("status").textContent).toContain("Camera on");
  });
});

describe("CameraController showing what it saw", () => {
  it("keeps the picture with the result for the hold time, then clears it and lets the picture go", async () => {
    vi.useFakeTimers();
    const { ctl, actions, revoked } = setup({ faces: async () => [[1]], sendFaces: async () => {} });
    await ctl.handle({ type: "camera.request", id: "r1", recognise: true });
    expect(stills(actions)).toEqual(["Looking…", "1 face found"]);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(5000);
    expect(stills(actions).at(-1)).toBe("clear");
    expect(revoked).toEqual(["blob:picture"]);
  });

  it("says when there was no face, and when the face models could not be loaded", async () => {
    const a = setup({ faces: async () => [], sendFaces: async () => {}, faceProblem: () => false });
    await a.ctl.handle({ type: "camera.request", id: "r1", recognise: true });
    expect(stills(a.actions).at(-1)).toBe("No face found");
    const b = setup({ faces: async () => [], sendFaces: async () => {}, faceProblem: () => true });
    await b.ctl.handle({ type: "camera.request", id: "r2", recognise: true });
    expect(stills(b.actions).at(-1)).toBe("The face models did not load");
  });

  it("a plain look just says it looked, and the next look replaces the picture on the screen", async () => {
    vi.useFakeTimers();
    const { ctl, actions, revoked } = setup();
    await ctl.handle({ type: "camera.request", id: "r1" });
    expect(stills(actions)).toEqual(["Looked"]);
    await ctl.handle({ type: "camera.request", id: "r2" });
    expect(revoked).toEqual(["blob:picture"]); // the first picture was let go when the second look began
  });
});
