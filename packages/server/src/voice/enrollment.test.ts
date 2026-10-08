import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { EnrollError, Enrollment } from "./enrollment";
import { fakeEmbedding } from "./service";
import { Voiceprint } from "./voiceprint";

const make = () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "friend-enr-")));
  const voiceprint = new Voiceprint(db, Buffer.alloc(32, 7));
  return { voiceprint, enrollment: new Enrollment(voiceprint, "test-model") };
};
const owner = (n: number) => fakeEmbedding("owner", `s${n}`);

describe("Enrollment", () => {
  it("collects samples, then stores one voiceprint on finish", () => {
    const { enrollment, voiceprint } = make();
    expect(enrollment.state()).toMatchObject({ enrolled: false, samples: 0, min: 3, max: 8 });
    for (let i = 0; i < 3; i++) enrollment.add(owner(i));
    expect(enrollment.state().samples).toBe(3);
    expect(enrollment.finish()).toEqual({ samples: 3 });
    expect(voiceprint.exists()).toBe(true);
    expect(enrollment.state()).toMatchObject({ enrolled: true, samples: 0 });
    expect(voiceprint.score(owner(9))!).toBeGreaterThan(0.72);
  });

  it("will not finish with too few samples", () => {
    const { enrollment, voiceprint } = make();
    enrollment.add(owner(1));
    enrollment.add(owner(2));
    expect(() => enrollment.finish()).toThrow(EnrollError);
    expect(() => enrollment.finish()).toThrow(/at least 3/);
    expect(voiceprint.exists()).toBe(false);
  });

  it("refuses samples that do not sound like one person", () => {
    const { enrollment, voiceprint } = make();
    enrollment.add(fakeEmbedding("owner", "a"));
    enrollment.add(fakeEmbedding("owner", "b"));
    enrollment.add(fakeEmbedding("someone-else", "c"));
    expect(() => enrollment.finish()).toThrow(/same person|agree/i);
    expect(voiceprint.exists()).toBe(false);
    expect(enrollment.state().samples).toBe(3); // the owner can cancel or record again
  });

  it("warns when a new sample is unlike the earlier ones", () => {
    const { enrollment } = make();
    expect(enrollment.add(owner(1)).note).toBeNull();
    expect(enrollment.add(owner(2)).note).toBeNull();
    expect(enrollment.add(fakeEmbedding("stranger", "x")).note).toMatch(/different/i);
  });

  it("stops at the maximum", () => {
    const { enrollment } = make();
    for (let i = 0; i < 8; i++) enrollment.add(owner(i));
    expect(() => enrollment.add(owner(99))).toThrow(/enough/i);
  });

  it("cancel drops the samples and finishing replaces an existing voiceprint", () => {
    const { enrollment, voiceprint } = make();
    enrollment.add(owner(1));
    enrollment.cancel();
    expect(enrollment.state().samples).toBe(0);
    for (let i = 0; i < 3; i++) enrollment.add(fakeEmbedding("first", `s${i}`));
    enrollment.finish();
    for (let i = 0; i < 3; i++) enrollment.add(fakeEmbedding("second", `s${i}`));
    enrollment.finish();
    expect(voiceprint.score(fakeEmbedding("second", "new"))!).toBeGreaterThan(0.72);
    expect(voiceprint.score(fakeEmbedding("first", "new"))!).toBeLessThan(0.58);
  });

  it("remove deletes the voiceprint", () => {
    const { enrollment, voiceprint } = make();
    for (let i = 0; i < 3; i++) enrollment.add(owner(i));
    enrollment.finish();
    enrollment.remove();
    expect(voiceprint.exists()).toBe(false);
    expect(enrollment.state().enrolled).toBe(false);
  });
});
