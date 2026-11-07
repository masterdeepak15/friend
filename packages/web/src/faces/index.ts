import { detectFaces } from "./detect";
import { embedFace } from "./embed";
import type { Face, Img, OrtLike, OrtSession } from "./types";

export type { Face, Img } from "./types";

const MAX_FACES = 5;
const MIN_FACE_PX = 60;

/** The biggest faces first, at most five, and none too small to be told apart. */
export function pickFaces(faces: Face[], max = MAX_FACES, minPx = MIN_FACE_PX): Face[] {
  return faces
    .filter((f) => Math.min(f.box[2], f.box[3]) >= minPx)
    .sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])
    .slice(0, max);
}

export interface FaceFinderDeps {
  load: () => Promise<{ ort: OrtLike; yunet: OrtSession; sface: OrtSession }>;
  decode: (jpeg: Blob) => Promise<Img>;
}

/**
 * Finds the faces in a camera picture and turns each into 128 numbers. Runs here in the browser, on a picture that is already here:
 * the picture is not sent anywhere by this code, and only the numbers are used afterwards. The models load the first time they are needed.
 */
export class FaceFinder {
  private loaded: ReturnType<FaceFinderDeps["load"]> | null = null;

  constructor(private deps: FaceFinderDeps) {}

  /** Never throws: a model that cannot be loaded or a picture that cannot be read means no faces. */
  async find(jpeg: Blob): Promise<number[][]> {
    try {
      this.loaded ??= this.deps.load();
      const { ort, yunet, sface } = await this.loaded;
      const img = await this.deps.decode(jpeg);
      const faces = pickFaces(await detectFaces(ort, yunet, img));
      const out: number[][] = [];
      for (const f of faces) out.push(await embedFace(ort, sface, img, f));
      return out;
    } catch {
      this.loaded = null;
      return [];
    }
  }
}

/** The picture as pixels, using the browser's own decoder. */
async function decodeInBrowser(jpeg: Blob): Promise<Img> {
  const bmp = await createImageBitmap(jpeg);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: d.data, width: d.width, height: d.height };
}

/**
 * The runtime files, named one by one. Left to itself the runtime asks for its ".jsep" build (made for graphics cards), which the package does not ship,
 * so the server answered with its home page and the models never loaded.
 */
export const ORT_PATHS = { mjs: "/ort/ort-wasm-simd-threaded.mjs", wasm: "/ort/ort-wasm-simd-threaded.wasm" } as const;

/** The finder the app uses: the models and the runtime come from this same server (/models and /ort), nothing from the internet. */
export function browserFaceFinder(): FaceFinder {
  return new FaceFinder({
    decode: decodeInBrowser,
    load: async () => {
      const ort = await import("onnxruntime-web");
      ort.env.wasm.wasmPaths = { ...ORT_PATHS };
      ort.env.wasm.numThreads = 1; // one thread needs no special page headers
      const make = async (url: string) => ort.InferenceSession.create(new Uint8Array(await (await fetch(url)).arrayBuffer()), { executionProviders: ["wasm"] });
      return { ort: ort as unknown as OrtLike, yunet: (await make("/models/yunet.onnx")) as unknown as OrtSession, sface: (await make("/models/sface.onnx")) as unknown as OrtSession };
    },
  });
}
