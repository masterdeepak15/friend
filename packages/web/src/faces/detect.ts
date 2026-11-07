import type { Face, Img, OrtLike, OrtSession } from "./types";

/** YuNet (OpenCV Zoo, MIT) takes a fixed 640 x 640 picture. */
export const YUNET_SIZE = 640;
const STRIDES = [8, 16, 32] as const;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The picture scaled to fit 640 x 640 (top-left, the rest black) as blue-green-red numbers, which is what the model was trained on. */
export function yunetInput(img: Img): { tensor: Float32Array; scale: number } {
  const scale = Math.min(YUNET_SIZE / img.width, YUNET_SIZE / img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const plane = YUNET_SIZE * YUNET_SIZE;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, (y + 0.5) / scale - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const fy = Math.max(0, sy - y0);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, (x + 0.5) / scale - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const fx = Math.max(0, sx - x0);
      const at = (px: number, py: number, c: number) => img.data[(py * img.width + px) * 4 + c]!;
      for (let c = 0; c < 3; c++) {
        const top = at(x0, y0, c) * (1 - fx) + at(x1, y0, c) * fx;
        const bottom = at(x0, y1, c) * (1 - fx) + at(x1, y1, c) * fx;
        out[(2 - c) * plane + y * YUNET_SIZE + x] = top * (1 - fy) + bottom * fy; // channel order B, G, R
      }
    }
  }
  return { tensor: out, scale };
}

const iou = (a: Face, b: Face) => {
  const [ax, ay, aw, ah] = a.box;
  const [bx, by, bw, bh] = b.box;
  const w = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
  const h = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (aw * ah + bw * bh - inter);
};

/** Turns the model's twelve outputs into faces in the picture's own pixels, strongest first, overlaps removed. */
export function decodeYunet(outputs: Record<string, { data: Float32Array | number[] }>, scale: number, minScore = 0.7, nms = 0.3): Face[] {
  const found: Face[] = [];
  for (const stride of STRIDES) {
    const cols = YUNET_SIZE / stride;
    const cls = outputs[`cls_${stride}`]!.data;
    const obj = outputs[`obj_${stride}`]!.data;
    const bbox = outputs[`bbox_${stride}`]!.data;
    const kps = outputs[`kps_${stride}`]!.data;
    for (let i = 0; i < cols * cols; i++) {
      const score = Math.sqrt(clamp01(cls[i]!) * clamp01(obj[i]!));
      if (score < minScore) continue;
      const r = Math.floor(i / cols);
      const c = i % cols;
      const cx = (c + bbox[i * 4]!) * stride;
      const cy = (r + bbox[i * 4 + 1]!) * stride;
      const w = Math.exp(bbox[i * 4 + 2]!) * stride;
      const h = Math.exp(bbox[i * 4 + 3]!) * stride;
      const landmarks: [number, number][] = [];
      for (let n = 0; n < 5; n++) landmarks.push([((kps[i * 10 + n * 2]! + c) * stride) / scale, ((kps[i * 10 + n * 2 + 1]! + r) * stride) / scale]);
      found.push({ box: [(cx - w / 2) / scale, (cy - h / 2) / scale, w / scale, h / scale], score, landmarks });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept: Face[] = [];
  for (const f of found) if (kept.every((k) => iou(k, f) < nms)) kept.push(f);
  return kept;
}

export async function detectFaces(ort: OrtLike, session: OrtSession, img: Img, minScore = 0.7): Promise<Face[]> {
  const { tensor, scale } = yunetInput(img);
  const outputs = await session.run({ [session.inputNames[0]!]: new ort.Tensor("float32", tensor, [1, 3, YUNET_SIZE, YUNET_SIZE]) });
  return decodeYunet(outputs, scale, minScore);
}
