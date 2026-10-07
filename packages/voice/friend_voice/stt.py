"""Speech to text with faster-whisper (CPU, int8)."""

from __future__ import annotations

import io
import threading
from typing import Optional


class WhisperSTT:
    def __init__(self, model_name: str, download_root: str) -> None:
        from faster_whisper import WhisperModel

        self._model = WhisperModel(model_name, device="cpu", compute_type="int8", download_root=download_root)
        self._lock = threading.Lock()  # the model is not safe for concurrent use

    def transcribe(self, audio: bytes, language: Optional[str]) -> dict:
        with self._lock:
            segments, info = self._model.transcribe(
                io.BytesIO(audio),  # any container PyAV can decode (webm/opus, mp4/aac, wav, ...)
                language=language,
                beam_size=1,
                vad_filter=True,  # drop silence so quiet clips return an empty transcript
                condition_on_previous_text=False,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
        return {"text": text, "language": info.language, "duration": round(float(info.duration), 3)}
