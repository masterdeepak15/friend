import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodeBox } from "./codebox";
import { inspectPlugin } from "./plugins";

const catalog = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins");
const ids = readdirSync(catalog);

describe("bundled catalog", () => {
  it("contains the example plugins and the skills that come with integrations", () => {
    expect(ids.sort()).toEqual(["ai-browser", "day-trader-india", "portfolio-assistant", "rubber-duck", "standup-writer", "tavily-search", "unit-converter"]);
  });

  it.each(ids)("%s is a valid plugin and its folder name is its id", (id) => {
    const r = inspectPlugin(join(catalog, id));
    expect(r.ok).toBe(true);
    expect(r.ok && r.manifest.id).toBe(id);
  });
});

function dockerHas(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dockerHas("python:3.12-alpine"))("unit-converter in a real container", () => {
  const r = inspectPlugin(join(catalog, "unit-converter"));
  const code = r.ok ? r.toolCode.get("convert")! : "";
  const convert = async (args: object) => {
    const out = await new CodeBox().run({ language: "python", code, timeoutSec: 20, files: { "args.json": JSON.stringify(args) } });
    if (!out.ok) throw new Error(out.error);
    return out;
  };

  it.each([
    [{ value: 5, from: "km", to: "mi" }, "5 km = 3.10686 mi"],
    [{ value: 100, from: "C", to: "F" }, "100 c = 212 f"],
    [{ value: 2.5, from: "lb", to: "kg" }, "2.5 lb = 1.13398 kg"],
    [{ value: 1, from: "gal", to: "ml" }, "1 gal = 3785.41 ml"],
    [{ value: -40, from: "f", to: "c" }, "-40 f = -40 c"],
  ])("converts %j", async (args, expected) => {
    const out = await convert(args);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe(expected);
  }, 60_000);

  it("says plainly when the units do not match or the temperature is impossible", async () => {
    const mixed = await convert({ value: 1, from: "kg", to: "km" });
    expect(mixed.exitCode).toBe(2);
    expect(mixed.stderr).toMatch(/cannot convert/i);
    const cold = await convert({ value: -500, from: "c", to: "f" });
    expect(cold.exitCode).toBe(2);
    expect(cold.stderr).toMatch(/absolute zero/i);
  }, 60_000);
});
