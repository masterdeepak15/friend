/** A picture as pixels: RGBA bytes, like the browser's ImageData. */
export interface Img {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** One face the detector found. Landmarks are the two eyes, the nose and the two mouth corners, in the picture's own pixels. */
export interface Face {
  box: [number, number, number, number]; // x, y, width, height
  score: number;
  landmarks: [number, number][];
}

/** The little of onnxruntime we use, so the code runs with the browser build, the Node build or a test double. */
export interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | number[] }>>;
}
export interface OrtLike {
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
}
