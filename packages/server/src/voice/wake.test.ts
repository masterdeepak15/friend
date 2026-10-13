import { describe, expect, it } from "vitest";
import { matchWake } from "./wake.js";

describe("saying the name to wake Friend", () => {
  it("wakes on a greeting and the name, however it is greeted", () => {
    for (const hello of ["hey", "Hey", "hay", "hello", "hellow", "hi", "ok", "okay", "yo", "हे", "हॅलो", "हाय"]) {
      expect(matchWake(`${hello} Maya`, "Maya"), hello).toEqual({ matched: true, rest: "" });
    }
  });

  it("wakes on the name alone at the start", () => {
    expect(matchWake("Maya, what time is it", "Maya")).toEqual({ matched: true, rest: "what time is it" });
  });

  it("hands back what was asked after the name, without the punctuation after the name", () => {
    expect(matchWake("Hey Maya, open my files.", "Maya")).toEqual({ matched: true, rest: "open my files." });
    expect(matchWake("hello maya... play some music", "Maya")).toEqual({ matched: true, rest: "play some music" });
    expect(matchWake("हे Maya, आज हवामान कसे आहे?", "Maya")).toEqual({ matched: true, rest: "आज हवामान कसे आहे?" });
  });

  it("forgives one wrong letter in a name of four or more letters", () => {
    for (const heard of ["Maia", "Maye", "Mayaa", "Maiya"]) {
      expect(matchWake(`hey ${heard}`, "Maya").matched, heard).toBe(true);
    }
  });

  it("does not forgive more than that, and never in a short name", () => {
    expect(matchWake("hey Mario", "Maya").matched).toBe(false);
    expect(matchWake("hey Bo", "Max").matched).toBe(false);
    expect(matchWake("hey Mac", "Max").matched).toBe(false);
  });

  it("ignores the name when it is only part of a sentence", () => {
    expect(matchWake("I told Maya to open my files", "Maya")).toEqual({ matched: false, rest: "" });
    expect(matchWake("what a lovely day", "Maya")).toEqual({ matched: false, rest: "" });
    expect(matchWake("hey there Maya", "Maya").matched).toBe(false);
  });

  it("does not wake on silence, noise, or no name", () => {
    expect(matchWake("", "Maya").matched).toBe(false);
    expect(matchWake("  ...  ", "Maya").matched).toBe(false);
    expect(matchWake("hey Maya", "").matched).toBe(false);
  });

  it("does not take a longer word that only starts like the name", () => {
    expect(matchWake("hey Mayank open it", "Maya").matched).toBe(false);
  });

  it("keeps a name with a space or a dash whole", () => {
    expect(matchWake("hey Mary Jane open it", "Mary Jane")).toEqual({ matched: true, rest: "open it" });
  });
});
