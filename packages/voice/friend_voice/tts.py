"""Text to speech with Piper."""

from __future__ import annotations

import re
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Optional

from .engines import wav_bytes


_VOICE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def check_voice_name(name: str) -> str:
    """A voice name becomes part of a file path, so only plain names (letters, digits, - and _) are allowed."""
    if not isinstance(name, str) or not _VOICE_NAME.fullmatch(name):
        raise ValueError("invalid voice name: use letters, digits, '-' and '_' only")
    return name


def ensure_voice(voice: str, download_dir: Path) -> Path:
    """Return the path to a voice's .onnx model, downloading it first if it is missing."""
    check_voice_name(voice)
    model = download_dir / f"{voice}.onnx"
    config = download_dir / f"{voice}.onnx.json"
    if model.exists() and config.exists():
        return model
    from piper.download_voices import download_voice

    download_dir.mkdir(parents=True, exist_ok=True)
    # An earlier download that was cut off (the program stopped, the network dropped) leaves a half model, or a model
    # without its config. Download into a scratch folder and move the finished files in, so that never stays behind.
    staging = Path(tempfile.mkdtemp(prefix=f"{voice}.", dir=download_dir))
    try:
        download_voice(voice, staging)
        (staging / f"{voice}.onnx").replace(model)
        (staging / f"{voice}.onnx.json").replace(config)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
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
        v = self._voice(check_voice_name(voice or self._default))
        pcm = bytearray()
        rate = 22050
        for chunk in v.synthesize(text):
            rate = chunk.sample_rate
            pcm += chunk.audio_int16_bytes
        return wav_bytes(bytes(pcm), rate)
