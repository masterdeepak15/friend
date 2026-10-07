"""Text to speech with Piper."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Optional

from .engines import wav_bytes


def ensure_voice(voice: str, download_dir: Path) -> Path:
    """Return the path to a voice's .onnx model, downloading it first if it is missing."""
    model = download_dir / f"{voice}.onnx"
    if not model.exists():
        from piper.download_voices import download_voice

        download_dir.mkdir(parents=True, exist_ok=True)
        download_voice(voice, download_dir)
    return model


class PiperTTS:
    def __init__(self, default_voice: str, download_dir: str) -> None:
        self._dir = Path(download_dir)
        self._default = default_voice
        self._voices: dict = {}
        self._lock = threading.Lock()
        self._voice(default_voice)  # fail early if the default voice cannot be loaded

    def _voice(self, name: str):
        from piper import PiperVoice

        with self._lock:
            if name not in self._voices:
                self._voices[name] = PiperVoice.load(str(ensure_voice(name, self._dir)))
            return self._voices[name]

    def synthesize(self, text: str, voice: Optional[str]) -> bytes:
        v = self._voice(voice or self._default)
        pcm = bytearray()
        rate = 22050
        for chunk in v.synthesize(text):
            rate = chunk.sample_rate
            pcm += chunk.audio_int16_bytes
        return wav_bytes(bytes(pcm), rate)
