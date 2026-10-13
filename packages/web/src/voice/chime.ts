let ctx: AudioContext | null = null;

/** A short rising two-note tone: "I heard my name, go ahead". Silent when the browser does not allow sound yet. */
export function chime(): void {
  try {
    ctx ??= new AudioContext();
    void ctx.resume().catch(() => {});
    const at = ctx.currentTime;
    for (const [i, hz] of [660, 990].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0, at + i * 0.11);
      gain.gain.linearRampToValueAtTime(0.18, at + i * 0.11 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, at + i * 0.11 + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at + i * 0.11);
      osc.stop(at + i * 0.11 + 0.16);
    }
  } catch {
    /* no sound is fine: the page also shows that it is listening */
  }
}
