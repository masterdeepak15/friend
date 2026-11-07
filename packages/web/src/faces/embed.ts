import { FACE_SIMILARITY_THRESHOLD } from "@friend/protocol";
import type { Face, Img, OrtLike, OrtSession } from "./types";

/** Where the two eyes, the nose and the two mouth corners sit in the 112 x 112 face SFace was trained on. */
const TEMPLATE: [number, number][] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];
export const FACE_SIZE = 112;
/** The server decides who someone is; the browser uses the same number only for its own checks. */
export const SIMILARITY_THRESHOLD = FACE_SIMILARITY_THRESHOLD;

/** The best turn, scale and shift that bring the five found points onto the template (least squares), as [a, b, tx, ty]. */
export function similarity(points: [number, number][]): [number, number, number, number] {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  const tx = TEMPLATE.reduce((s, p) => s + p[0], 0) / n;
  const ty = TEMPLATE.reduce((s, p) => s + p[1], 0) / n;
  let num1 = 0;
  let num2 = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const x = points[i]![0] - mx;
    const y = points[i]![1] - my;
    const u = TEMPLATE[i]![0] - tx;
    const v = TEMPLATE[i]![1] - ty;
    num1 += x * u + y * v;
    num2 += x * v - y * u;
    den += x * x + y * y;
  }
  const a = num1 / den;
  const b = num2 / den;
  return [a, b, tx - (a * mx - b * my), ty - (b * mx + a * my)];
}

/** The face cut out, straightened and scaled to 112 x 112, as red-green-blue numbers 0..255 laid out plane by plane. */
export function alignFace(img: Img, landmarks: [number, number][]): Float32Array {
  const [a, b, tx, ty] = similarity(landmarks);
  const d = a * a + b * b;
  const plane = FACE_SIZE * FACE_SIZE;
  const out = new Float32Array(3 * plane);
  for (let v = 0; v < FACE_SIZE; v++) {
    for (let u = 0; u < FACE_SIZE; u++) {
      // back from the template to the picture: p = M^-1 (q - t)
      const qx = u - tx;
      const qy = v - ty;
      const sx = (a * qx + b * qy) / d;
      const sy = (-b * qx + a * qy) / d;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let c = 0; c < 3; c++) {
        const at = (px: number, py: number) => {
          const cx = Math.min(img.width - 1, Math.max(0, px));
          const cy = Math.min(img.height - 1, Math.max(0, py));
          return img.data[(cy * img.width + cx) * 4 + c]!;
        };
        const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
        const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
        out[c * plane + v * FACE_SIZE + u] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return out;
}

/** The 128 numbers that stand for this face. Two pictures of one person give vectors that point the same way. */
export async function embedFace(ort: OrtLike, session: OrtSession, img: Img, face: Pick<Face, "landmarks">): Promise<number[]> {
  const input = alignFace(img, face.landmarks);
  const out = await session.run({ [session.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, FACE_SIZE, FACE_SIZE]) });
  return Array.from(out[session.outputNames[0]!]!.data);
}

/** 1 for the same direction, 0 for unrelated, -1 for opposite. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
