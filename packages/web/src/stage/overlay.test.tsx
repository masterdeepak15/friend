import type { ClientMsg } from "@friend/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce, type StageViewState } from "../store";
import { Stage } from "./Stage";

afterEach(cleanup);

const obj = (id: string, extra: object = {}) => ({ id, type: "card" as const, props: { title: id, text: `text of ${id}` }, placement: "left" as const, ...extra });
const stageWith = (objects: unknown[]): StageViewState => ({ ...initialState, connection: "open", objects: objects as StageViewState["objects"] });

describe("an overlay", () => {
  it("floats over the screen in its own layer, and the widgets underneath stay where they are", () => {
    const { container } = render(<Stage state={stageWith([obj("widget"), obj("why", { layer: "overlay", placement: "center" })])} send={() => {}} dispatch={() => {}} />);
    const layer = screen.getByTestId("overlay");
    expect(layer.querySelector('[data-object="why"]')).toBeTruthy();
    expect(layer.querySelector('[data-object="widget"]')).toBeNull();
    expect(container.querySelector(".objects [data-object=\"widget\"]")).toBeTruthy();
    expect(container.querySelector(".objects [data-object=\"why\"]")).toBeNull();
  });

  it("has nothing to drag or pin, but can be dismissed", () => {
    const send = vi.fn<(m: ClientMsg) => void>();
    const dispatch = vi.fn();
    render(<Stage state={stageWith([obj("why", { layer: "overlay", placement: "center" })])} send={send} dispatch={dispatch} />);
    const layer = screen.getByTestId("overlay");
    expect(layer.querySelector(".obj-grip")).toBeNull();
    expect(layer.querySelector(".obj-pin")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss why" }));
    expect(send).toHaveBeenCalledWith({ type: "stage.event", objectId: "why", event: "dismiss" });
    expect(dispatch).toHaveBeenCalledWith({ type: "object.dismiss", id: "why" });
  });

  it("is dismissed by a click on the dimmed screen", () => {
    const send = vi.fn<(m: ClientMsg) => void>();
    const dispatch = vi.fn();
    const { container } = render(<Stage state={stageWith([obj("why", { layer: "overlay", placement: "center" })])} send={send} dispatch={dispatch} />);
    fireEvent.click(container.querySelector(".overlay-backdrop")!);
    expect(dispatch).toHaveBeenCalledWith({ type: "object.dismiss", id: "why" });
  });

  it("draws no layer when nothing is on top", () => {
    render(<Stage state={stageWith([obj("widget")])} send={() => {}} dispatch={() => {}} />);
    expect(screen.queryByTestId("overlay")).toBeNull();
  });

  it("keeps its layer through the store", () => {
    const s = reduce(initialState, { type: "stage", command: { cmd: "show", object: obj("why", { layer: "overlay", placement: "center" }) } });
    expect(s.objects[0]!.layer).toBe("overlay");
  });
});
