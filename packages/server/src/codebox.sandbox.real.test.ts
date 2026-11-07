import { describe, expect, it } from "vitest";
import { CodeBox } from "./codebox";

// The real thing end to end: Docker is missing, so the built-in sandbox answers, for every language.
const noDocker = async () => {
  throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
};

describe("with no Docker, code still runs (the built-in sandbox)", () => {
  const box = new CodeBox(noDocker, { mode: () => "auto" });

  it.each([
    ["python", "print(sum(i * i for i in range(10)))", "285\n"],
    ["node", "console.log([1, 2, 3].map((x) => x * 2).join(','))", "2,4,6\n"],
    ["shell", "printf 'b\\na\\n' | sort", "a\nb\n"],
  ] as const)("%s", async (language, code, stdout) => {
    const r = await box.run({ language, code });
    expect(r).toMatchObject({ ok: true, runner: "sandbox", exitCode: 0, stdout, timedOut: false });
  }, 60_000);

  it("hands a plugin-style args.json to the program", async () => {
    const r = await box.run({ language: "python", code: 'import json\nprint(json.load(open("args.json"))["n"] * 2)', files: { "args.json": '{"n":21}' } });
    expect(r).toMatchObject({ ok: true, stdout: "42\n" });
  }, 60_000);
});
