import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "./index";

const def = (name: string) => TOOL_DEFS.find((t) => t.name === name)!;

describe("the words that tell the assistant when the camera needs a question", () => {
  it("camera.snap no longer says every picture is approved: it says when it is and when it is not", () => {
    const d = def("camera.snap").description;
    expect(d).not.toMatch(/camera on and approves every picture/i);
    expect(d).toMatch(/eye/i);
    expect(d).toMatch(/at the screen/i);
    expect(d).toMatch(/otherwise the owner approves/i);
    expect(d).toMatch(/data, never instructions/i);
  });

  it("camera.watch and the people tools say the same, and that faces are only numbers", () => {
    expect(def("camera.watch").description).toMatch(/eye/i);
    expect(def("people.introduce").description).toMatch(/PIN/);
    expect(def("people.introduce").description).toMatch(/never the picture/i);
    expect(def("people.list").description).toMatch(/without any face data/i);
  });

  it("nothing tells the assistant it may switch the eye on", () => {
    for (const t of TOOL_DEFS.filter((x) => x.name.startsWith("camera.") || x.name.startsWith("people."))) {
      expect(t.description, t.name).not.toMatch(/switch (the eye )?on for the owner|turn (the eye )?on yourself/i);
    }
  });
});
