// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import * as ort from "onnxruntime-web";
import { beforeAll, describe, expect, it } from "vitest";
import { detectFaces } from "./detect";
import { cosine, embedFace, SIMILARITY_THRESHOLD } from "./embed";
import type { Img, OrtSession } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const models = join(here, "..", "..", "public", "models");
const photo = (name: string): Img => {
  const d = jpeg.decode(readFileSync(join(here, "fixtures", name)), { useTArray: true });
  return { data: d.data, width: d.width, height: d.height };
};

let yunet: OrtSession;
let sface: OrtSession;
beforeAll(async () => {
  ort.env.logLevel = "error";
  yunet = (await ort.InferenceSession.create(readFileSync(join(models, "yunet.onnx")), { executionProviders: ["wasm"] })) as unknown as OrtSession;
  sface = (await ort.InferenceSession.create(readFileSync(join(models, "sface.onnx")), { executionProviders: ["wasm"] })) as unknown as OrtSession;
}, 60_000);

async function vector(name: string): Promise<number[]> {
  const img = photo(name);
  const faces = await detectFaces(ort as never, yunet, img);
  expect(faces.length, `${name}: faces found`).toBe(1);
  return embedFace(ort as never, sface, img, faces[0]!);
}

describe("face models run on this system (YuNet + SFace through onnxruntime-web)", () => {
  it("yunet finds one face in a portrait", async () => {
    const faces = await detectFaces(ort as never, yunet, photo("obama_a.jpg"));
    expect(faces).toHaveLength(1);
    expect(faces[0]!.landmarks).toHaveLength(5);
  }, 60_000);

  it("returns no face for a picture of a wall", async () => {
    expect(await detectFaces(ort as never, yunet, photo("wall.jpg"))).toHaveLength(0);
  }, 60_000);

  it("sface gives the same person a higher similarity than a different person", async () => {
    const [oa, ob, ba, bb, ga] = await Promise.all(["obama_a.jpg", "obama_b.jpg", "biden_a.jpg", "biden_b.jpg", "bush_a.jpg"].map(vector));
    const same = [cosine(oa!, ob!), cosine(ba!, bb!)];
    const different = [cosine(oa!, ba!), cosine(oa!, bb!), cosine(ob!, ba!), cosine(ob!, bb!), cosine(oa!, ga!), cosine(ob!, ga!), cosine(ba!, ga!), cosine(bb!, ga!)];
    process.stderr.write(`SIMILARITY same=${same.map((s) => s.toFixed(3))} different=${different.map((s) => s.toFixed(3))}\n`);
    expect(Math.min(...same)).toBeGreaterThan(Math.max(...different));
    expect(Math.min(...same)).toBeGreaterThan(SIMILARITY_THRESHOLD);
    expect(Math.max(...different)).toBeLessThan(SIMILARITY_THRESHOLD);
  }, 120_000);
});
