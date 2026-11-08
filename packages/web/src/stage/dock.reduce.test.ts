import type { StageObject } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../store";

const obj = (id: string): StageObject => ({ id, type: "card", props: { text: id }, placement: "auto" });
const withObjects = () => ({ ...initialState, objects: [obj("a"), obj("b")] });
const dock = (id: string, docked: boolean) => ({ type: "stage", command: { cmd: "dock", id, docked } });

describe("the dock command in the screen state", () => {
  it("sets docked on that object only, and a second dock clears it", () => {
    const docked = reduce(withObjects(), dock("a", true));
    expect(docked.objects.find((o) => o.id === "a")?.docked).toBe(true);
    expect(docked.objects.find((o) => o.id === "b")?.docked).toBeUndefined();
    const back = reduce(docked, dock("a", false));
    expect(back.objects.find((o) => o.id === "a")).not.toHaveProperty("docked");
  });
  it("changes nothing for an unknown id", () => {
    const s = withObjects();
    expect(reduce(s, dock("zzz", true)).objects).toEqual(s.objects);
  });
});
