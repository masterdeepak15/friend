"""Speech to text with faster-whisper (CPU, int8)."""

from __future__ import annotations

import io
import threading
from typing import Optional

#: Longest recording accepted. Longer audio is refused while decoding, before any transcription work.
MAX_SECONDS = 90.0
SAMPLE_RATE = 16000

#: Speech quieter than this (RMS) is brought up toward it; a speaker far from the microphone arrives faint.
TARGET_RMS = 0.06
#: Below this the room is silent, so there is nothing to bring up (it would only make hiss louder).
SILENCE_RMS = 0.001
MAX_GAIN = 20.0
#: A segment is dropped when the model thinks it is probably not speech AND is not sure of its words (Whisper's own rule),
#: or when it is very unsure of its words whatever the speech chance: noise turns into invented words in other scripts.
NO_SPEECH_PROB = 0.6
MIN_LOGPROB = -1.0
HOPELESS_LOGPROB = -2.0

#: A sentence in the style wanted, given to the recognizer as a hint: Hindi and Marathi are written in Devanagari,
#: and the English words that people mix in stay in Latin letters.
HINT_PROMPTS = {
    "hi": "नमस्ते, आज मौसम कैसा है? Meeting पाँच बजे है, please remind me.",
    "mr": "नमस्कार, आज हवामान कसे आहे? Meeting पाच वाजता आहे, please remind me.",
}


def level(samples):
    """Bring faint speech up to a usable volume without clipping; leave loud enough speech and silence alone."""
    import numpy as np

    if samples.size == 0:
        return samples
    loudness = float(np.sqrt(np.mean(np.square(samples))))
    if loudness >= TARGET_RMS or loudness < SILENCE_RMS:
        return samples
    peak = float(np.max(np.abs(samples)))
    gain = min(TARGET_RMS / loudness, MAX_GAIN, 0.99 / peak if peak > 0 else MAX_GAIN)
    return (samples * gain).astype(np.float32)


def believed(segment) -> bool:
    """Whether to keep what the model heard in this segment."""
    no_speech = getattr(segment, "no_speech_prob", 0.0)
    logprob = getattr(segment, "avg_logprob", 0.0)
    if no_speech > NO_SPEECH_PROB and logprob < MIN_LOGPROB:
        return False
    return logprob >= HOPELESS_LOGPROB


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
    return level(np.concatenate(pieces).astype(np.float32) / 32768.0)


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
            beam_size=5,  # a wider search is slower but much better on faint or accented speech
            vad_filter=True,  # drop silence so quiet clips return an empty transcript
            condition_on_previous_text=False,
            no_speech_threshold=NO_SPEECH_PROB,
            log_prob_threshold=MIN_LOGPROB,
            compression_ratio_threshold=2.4,  # repeated gibberish compresses well: the model tries again instead of keeping it
            **extra,
        )
        return " ".join(s.text.strip() for s in segments if believed(s)).strip(), info

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
