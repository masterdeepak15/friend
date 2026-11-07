import { describe, expect, it } from "vitest";
import { ClientMsg } from "./messages";
import { TOOL_DEFS } from "./tools";

const def = () => TOOL_DEFS.find((t) => t.name === "screen.compose");
const item = (id: string, role = "focus") => ({ id, type: "card", props: { text: id }, role });

describe("the screen.compose tool", () => {
  it("exists, is open (T0) and runs on the gateway", () => {
    expect(def()).toMatchObject({ baseTier: "T0", target: "gateway" });
  });
  it("accepts a few items with a role and an optional mode", () => {
    expect(def()!.input.safeParse({ items: [item("a"), item("b", "beside")], mode: "add" }).success).toBe(true);
  });
  it("rejects nine items, no items and an unknown role", () => {
    expect(def()!.input.safeParse({ items: Array.from({ length: 9 }, (_, i) => item(`i${i}`)) }).success).toBe(false);
    expect(def()!.input.safeParse({ items: [] }).success).toBe(false);
    expect(def()!.input.safeParse({ items: [item("a", "hero")] }).success).toBe(false);
  });
  it("the screen can send stage.dock to bring a chip back", () => {
    expect(ClientMsg.safeParse({ type: "stage.dock", objectId: "a", docked: false }).success).toBe(true);
    expect(ClientMsg.safeParse({ type: "stage.dock", docked: false }).success).toBe(false);
  });
});
