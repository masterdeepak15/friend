import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CodeBox, type DockerExec } from "./codebox";

/** Captures the mounted folder's files at the moment docker would run. */
function capture() {
  const seen: Record<string, string>[] = [];
  const exec: DockerExec = async (args) => {
    const mount = args[args.indexOf("-v") + 1]!;
    const dir = mount.slice(0, mount.lastIndexOf(":/work:ro"));
    const files: Record<string, string> = {};
    for (const f of ["main.py", "main.js", "main.sh", "args.json", "data.txt"]) if (existsSync(`${dir}/${f}`)) files[f] = readFileSync(`${dir}/${f}`, "utf8");
    seen.push(files);
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { exec, seen };
}

describe("CodeBox extra files", () => {
  it("puts extra files next to the program, in the same read-only folder", async () => {
    const c = capture();
    await new CodeBox(c.exec).run({ language: "python", code: "print(1)", files: { "args.json": '{"value":5}' } });
    expect(c.seen[0]).toEqual({ "main.py": "print(1)", "args.json": '{"value":5}' });
  });

  it.each([["../evil.txt"], ["sub/dir.txt"], ["a\\b"], ["main.py"], ["/abs"], [""], ["x".repeat(65)]])("refuses the file name %j", async (name) => {
    const c = capture();
    const r = await new CodeBox(c.exec).run({ language: "python", code: "1", files: { [name]: "x" } });
    expect(r).toEqual({ ok: false, error: "That file name is not allowed in the sandbox." });
    expect(c.seen).toHaveLength(0);
  });

  it("refuses too many or too large extra files", async () => {
    const c = capture();
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}.txt`, "x"]));
    expect(await new CodeBox(c.exec).run({ language: "python", code: "1", files: many })).toEqual({ ok: false, error: "Too many files for the sandbox." });
    const big = await new CodeBox(c.exec).run({ language: "python", code: "1", files: { "data.txt": "x".repeat(200_001) } });
    expect(big).toEqual({ ok: false, error: "The sandbox files are too large." });
    expect(c.seen).toHaveLength(0);
  });
});
