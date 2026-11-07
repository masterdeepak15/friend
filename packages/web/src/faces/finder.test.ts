// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import * as ort from "onnxruntime-web";
import { describe, expect, it } from "vitest";
import { FaceFinder, pickFaces } from "./index";
import type { Face, OrtSession } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const models = join(here, "..", "..", "public", "models");
const asBlob = (name: string) => new Blob([readFileSync(join(here, "fixtures", name))], { type: "image/jpeg" });
const decode = async (b: Blob) => {
  const d = jpeg.decode(Buffer.from(await b.arrayBuffer()), { useTArray: true });
  return { data: d.data, width: d.width, height: d.height };
};
const finder = () =>
  new FaceFinder({
    decode,
    load: async () => {
      ort.env.logLevel = "error";
      return {
        ort: ort as never,
        yunet: (await ort.InferenceSession.create(readFileSync(join(models, "yunet.onnx")), { executionProviders: ["wasm"] })) as unknown as OrtSession,
        sface: (await ort.InferenceSession.create(readFileSync(join(models, "sface.onnx")), { executionProviders: ["wasm"] })) as unknown as OrtSession,
      };
    },
  });

const box = (w: number, score = 0.9): Face => ({ box: [0, 0, w, w], score, landmarks: [[0, 0], [1, 0], [0, 1], [1, 1], [2, 2]] });

describe("pickFaces", () => {
  it("keeps the biggest faces first, at most five, and ignores tiny ones", () => {
    const faces = [box(30), box(200), box(80), box(120), box(90), box(70), box(60), box(59)];
    expect(pickFaces(faces).map((f) => f.box[2])).toEqual([200, 120, 90, 80, 70]);
    expect(pickFaces(faces, 2).map((f) => f.box[2])).toEqual([200, 120]);
    expect(pickFaces([box(10)])).toEqual([]);
  });
});

describe("FaceFinder", () => {
  it("gives 128 numbers for the face in a portrait, and nothing for a wall", async () => {
    const f = finder();
    const faces = await f.find(asBlob("obama_a.jpg"));
    expect(faces).toHaveLength(1);
    expect(faces[0]).toHaveLength(128);
    expect(await f.find(asBlob("wall.jpg"))).toEqual([]);
  }, 120_000);

  it("gives numbers that match the same person and not another", async () => {
    const f = finder();
    const [a] = await f.find(asBlob("obama_a.jpg"));
    const [b] = await f.find(asBlob("obama_b.jpg"));
    const [c] = await f.find(asBlob("biden_a.jpg"));
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0) / (Math.hypot(...x) * Math.hypot(...y));
    expect(cos(a!, b!)).toBeGreaterThan(0.55);
    expect(cos(a!, c!)).toBeLessThan(0.55);
  }, 120_000);

  it("does not break a look when the models cannot be loaded: it finds no faces", async () => {
    const broken = new FaceFinder({ decode, load: async () => Promise.reject(new Error("no models")) });
    expect(await broken.find(asBlob("obama_a.jpg"))).toEqual([]);
  });
});
