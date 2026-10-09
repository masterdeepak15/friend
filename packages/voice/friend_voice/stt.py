"""Speech to text with faster-whisper (CPU, int8)."""

from __future__ import annotations

import io
import threading
from typing import Optional

#: Longest recording accepted. Longer audio is refused while decoding, before any transcription work.
MAX_SECONDS = 90.0
SAMPLE_RATE = 16000

#: A sentence in the style wanted, given to the recognizer as a hint: Hindi and Marathi are written in Devanagari,
#: and the English words that people mix in stay in Latin letters.
HINT_PROMPTS = {
    "hi": "नमस्ते, आज मौसम कैसा है? Meeting पाँच बजे है, please remind me.",
    "mr": "नमस्कार, आज हवामान कसे आहे? Meeting पाच वाजता आहे, please remind me.",
}


def decode_audio(data: bytes, max_seconds: float = MAX_SECONDS):
    """Decode any container PyAV understands (webm/opus, mp4/aac, wav, ...) to mono float32 at 16 kHz.

    Raises ValueError when the audio is longer than `max_seconds`, without decoding the rest.
    """
    import av
    import numpy as np

    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    limit = int(max_seconds * SAMPLE_RATE)
    pieces = []
    total = 0

    def take(frames) -> None:
        nonlocal total
        for frame in frames:
            samples = frame.to_ndarray().reshape(-1)
            total += samples.size
            if total > limit:
                raise ValueError(f"recording longer than {max_seconds:.0f} seconds")
            pieces.append(samples)

    with av.open(io.BytesIO(data), mode="r") as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise ValueError("no audio found in the recording")
        for frame in container.decode(stream):
            take(resampler.resample(frame))
        take(resampler.resample(None))  # flush
    if not pieces:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(pieces).astype(np.float32) / 32768.0


class WhisperSTT:
    def __init__(self, model_name: str, download_root: str) -> None:
        from faster_whisper import WhisperModel

        self._model = WhisperModel(model_name, device="cpu", compute_type="int8", download_root=download_root)
        self._lock = threading.Lock()  # the model is not safe for concurrent use

    def _run(self, samples, language: Optional[str], prompt: Optional[str]):
        extra = {"initial_prompt": prompt} if prompt else {}
        segments, info = self._model.transcribe(
            samples,
            language=language,
            beam_size=1,
            vad_filter=True,  # drop silence so quiet clips return an empty transcript
            condition_on_previous_text=False,
            **extra,
        )
        return " ".join(s.text.strip() for s in segments).strip(), info

    def transcribe(self, audio: bytes, language: Optional[str]) -> dict:
        samples = decode_audio(audio)  # bounded decode: hostile or huge input is refused here
        if samples.size == 0:
            return {"text": "", "language": language or "en", "duration": 0.0}
        with self._lock:
            text, info = self._run(samples, language, HINT_PROMPTS.get(language) if language else None)
            if language is None and text and info.language in HINT_PROMPTS:
                # It heard Hindi or Marathi on its own. Say it again, now knowing the language and with a hint that
                # writes Hindi/Marathi in Devanagari and keeps English words in Latin letters (mixed speech).
                again, again_info = self._run(samples, info.language, HINT_PROMPTS[info.language])
                if again:
                    text, info = again, again_info
        return {"text": text, "language": info.language, "duration": round(samples.size / SAMPLE_RATE, 3)}
