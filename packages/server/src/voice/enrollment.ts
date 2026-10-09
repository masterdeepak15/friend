import { centroid, checkConsistency, cosine } from "./voiceprint";

/** Where a finished enrollment goes: the owner's voiceprint, or one person of the household. */
export interface PrintStore {
  exists(): boolean;
  enroll(embeddings: readonly (readonly number[])[], model: string): void;
  clear(): void;
}

/** A mistake the owner can fix (not enough samples, mixed voices). Safe to show as is. */
export class EnrollError extends Error {}

export interface EnrollState {
  enrolled: boolean;
  samples: number;
  min: number;
  max: number;
}

export const MIN_SAMPLES = 3;
export const MAX_SAMPLES = 8;

/** A new sample this far from the earlier ones probably is not the same speaker, or was a bad recording. */
const SAMPLE_WARN = 0.5;
const CONSISTENT = 0.55;

/** One enrollment in progress. The samples stay in memory; only the final average is stored. */
export class Enrollment {
  private samples: number[][] = [];

  constructor(
    private voiceprint: PrintStore,
    private model: string,
  ) {}

  state(): EnrollState {
    return { enrolled: this.voiceprint.exists(), samples: this.samples.length, min: MIN_SAMPLES, max: MAX_SAMPLES };
  }

  add(embedding: number[]): { count: number; note: string | null } {
    if (this.samples.length >= MAX_SAMPLES) throw new EnrollError("That is enough samples. Finish or start over.");
    let note: string | null = null;
    if (this.samples.length >= 2 && cosine(embedding, centroid(this.samples)) < SAMPLE_WARN) {
      note = "That sounded different from your earlier phrases. Speak close to the microphone in a quiet room.";
    }
    this.samples.push(embedding);
    return { count: this.samples.length, note };
  }

  finish(): { samples: number } {
    if (this.samples.length < MIN_SAMPLES) throw new EnrollError(`Record at least ${MIN_SAMPLES} phrases first.`);
    if (!checkConsistency(this.samples, CONSISTENT).ok) {
      throw new EnrollError("The recordings do not agree with each other. They must all be the same person; start over.");
    }
    const n = this.samples.length;
    this.voiceprint.enroll(this.samples, this.model);
    this.samples = [];
    return { samples: n };
  }

  cancel(): void {
    this.samples = [];
  }

  remove(): void {
    this.samples = [];
    this.voiceprint.clear();
  }
}
