import { describe, expect, it } from "vitest";
import { MUSIC_OUTPUTS, programProblem } from "./hud";

describe("programProblem", () => {
  it("accepts empty (find it automatically), a name and a path without spaces", () => {
    for (const ok of ["", "mpv", "mpv.exe", "/usr/bin/mpv", "C:\mpv\mpv.exe", "~/bin/mpv", "C:/Tools/mpv.exe"]) expect(programProblem(ok), ok).toBeNull();
  });
  it("refuses arguments, quotes, operators, a leading dash and anything too long", () => {
    for (const bad of ["mpv --no-video", "-x", "a;b", "a|b", "a&b", "a>b", "a<b", '"mpv"', "'mpv'", "mpv\n", "$(x)", "`x`", "C:\Program Files\mpv\mpv.exe", "x".repeat(261)]) expect(programProblem(bad), bad).not.toBeNull();
  });
  it("tells a path with spaces what to do instead", () => {
    expect(programProblem("C:\Program Files\mpv\mpv.exe")).toMatch(/short path|PATH/i);
  });
  it("knows the two outputs", () => {
    expect([...MUSIC_OUTPUTS]).toEqual(["screen", "host"]);
  });
});
