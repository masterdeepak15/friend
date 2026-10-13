const STATUS_TEXT: Record<number, string> = {
  401: "Please sign in again.",
  413: "That recording was too long.",
  409: "Friend is busy with the last request. Try again in a moment.",
  429: "You're talking too fast. Wait a moment.",
  503: "Voice is not available. Run: friend voice setup",
};

async function upload(url: string, audio: Blob, signal?: AbortSignal): Promise<{ text: string; wake?: boolean }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": audio.type || "audio/webm" },
      body: audio,
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e; // cancelled on purpose: not a network problem
    throw new Error("Could not reach Friend. Check the connection.");
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* no JSON body */
    }
    throw new Error(detail || STATUS_TEXT[res.status] || `The voice request failed (${res.status}).`);
  }
  const json = (await res.json()) as { text?: unknown; wake?: unknown };
  return { text: typeof json.text === "string" ? json.text : "", wake: json.wake === true };
}

/** Uploads one recording to the gateway; resolves with what Friend heard ("" when nothing intelligible). */
export async function postUtterance(audio: Blob, signal?: AbortSignal): Promise<{ text: string }> {
  return { text: (await upload("/api/voice/utterance", audio, signal)).text };
}

/**
 * Hands-free: uploads what was said and asks whether it began with the assistant's name. `wake` is true when it did; then `text`
 * is the request that came with it (already running) or "" when only the name was said.
 */
export async function postWake(audio: Blob, signal?: AbortSignal): Promise<{ text: string; wake: boolean }> {
  const r = await upload("/api/voice/utterance?wake=1", audio, signal);
  return { text: r.text, wake: r.wake === true };
}
