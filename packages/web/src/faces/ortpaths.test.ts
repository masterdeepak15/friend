// @vitest-environment node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, basename } from "node:path";
import { describe, expect, it } from "vitest";
import { ORT_PATHS } from "./index";

describe("the runtime files the browser is told to fetch", () => {
  it("name the plain build that the package ships, never the .jsep build it does not", () => {
    const dist = dirname(createRequire(import.meta.url).resolve("onnxruntime-web"));
    for (const url of Object.values(ORT_PATHS)) {
      expect(url.startsWith("/ort/")).toBe(true);
      expect(url).not.toMatch(/jsep|jspi|asyncify/);
      expect(existsSync(join(dist, basename(url)))).toBe(true);
    }
  });
});
