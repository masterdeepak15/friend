import type { ClientMsg } from "@friend/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, type StageViewState } from "../store";
import { Stage } from "./Stage";

afterEach(cleanup);

const card = (id: string, extra: object = {}) => ({ id, type: "card" as const, props: { title: id, text: `text of ${id}` }, placement: "left" as const, ...extra });
const stat = (id: string, extra: object = {}) => ({ id, type: "stat" as const, props: { label: "Temp", value: 24, unit: "C" }, placement: "auto" as const, ...extra });
const stageWith = (objects: unknown[]): StageViewState => ({ ...initialState, connection: "open", objects: objects as StageViewState["objects"] });

describe("put-away chips", () => {
  it("a docked object shows as a chip with its label and value, and not as a card", () => {
    const { container } = render(<Stage state={stageWith([card("a"), stat("t", { docked: true, role: "glance" })])} send={() => {}} dispatch={() => {}} />);
    expect(container.querySelector('[data-object="a"]')).toBeTruthy();
    expect(container.querySelector('[data-object="t"]')).toBeNull();
    const chip = screen.getByRole("button", { name: "Show Temp" });
    expect(chip.textContent).toMatch(/Temp/);
    expect(chip.textContent).toMatch(/24 C/);
  });

  it("clicking a chip asks the server to bring it back", () => {
    const send = vi.fn<(m: ClientMsg) => void>();
    render(<Stage state={stageWith([card("a", { docked: true })])} send={send} dispatch={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Show a" }));
    expect(send).toHaveBeenCalledWith({ type: "stage.dock", objectId: "a", docked: false });
  });

  it("is an ordinary button, so Enter and Space work (the browser sends the click)", () => {
    render(<Stage state={stageWith([card("a", { docked: true })])} send={() => {}} dispatch={() => {}} />);
    expect(screen.getByRole("button", { name: "Show a" }).tagName).toBe("BUTTON");
  });

  it("has no strip when nothing is put away", () => {
    render(<Stage state={stageWith([card("a")])} send={() => {}} dispatch={() => {}} />);
    expect(screen.queryByRole("navigation", { name: "Put away" })).toBeNull();
  });

  it("keeps docked overlays and cards out of the overlay layer too", () => {
    render(<Stage state={stageWith([card("n", { docked: true, layer: "overlay", placement: "center" })])} send={() => {}} dispatch={() => {}} />);
    expect(screen.queryByTestId("overlay")).toBeNull();
    expect(screen.getByRole("button", { name: "Show n" })).toBeTruthy();
  });

  it("the strip is a labelled landmark and never covers the captions (it is at the top)", () => {
    const { container } = render(<Stage state={stageWith([card("a", { docked: true })])} send={() => {}} dispatch={() => {}} />);
    const strip = screen.getByRole("navigation", { name: "Put away" });
    expect(strip.className).toMatch(/chip-strip/);
    expect(container.querySelector(".captions")).toBeNull();
  });

  it("a chip with props that break its label does not break the stage", () => {
    render(<Stage state={stageWith([card("a"), { id: "weird", type: "stat", props: { label: { x: 1 }, value: { y: 2 } }, placement: "auto", docked: true }])} send={() => {}} dispatch={() => {}} />);
    expect(screen.getByRole("button", { name: "Show weird" })).toBeTruthy();
  });

  it("the strip holds as many chips as are docked (the server keeps the limit)", () => {
    render(<Stage state={stageWith(["a", "b", "c"].map((id) => card(id, { docked: true })))} send={() => {}} dispatch={() => {}} />);
    expect(screen.getAllByRole("button", { name: /^Show / })).toHaveLength(3);
  });
});

describe("chips keep clear of open panels", () => {
  const chipsOnly = stageWith([card("a", { docked: true }), card("b", { docked: true })]);
  const strip = (c: HTMLElement) => c.querySelector<HTMLElement>(".chip-strip")!;
  it("with the chat panel open the strip ends before it", () => {
    const { container } = render(<Stage state={chipsOnly} send={() => {}} dispatch={() => {}} panelsOpen={{ chat: true, tasks: false }} />);
    expect(strip(container).style.right).toBe("32%");
    expect(strip(container).style.left).toBe("2%");
  });
  it("with the tasks panel open the strip starts after it", () => {
    const { container } = render(<Stage state={chipsOnly} send={() => {}} dispatch={() => {}} panelsOpen={{ chat: false, tasks: true }} />);
    expect(strip(container).style.left).toBe("30%");
    expect(strip(container).style.right).toBe("2%");
  });
  it("with no panel open the strip spans the safe width", () => {
    const { container } = render(<Stage state={chipsOnly} send={() => {}} dispatch={() => {}} />);
    expect(strip(container).style.left).toBe("2%");
    expect(strip(container).style.right).toBe("2%");
  });
});
