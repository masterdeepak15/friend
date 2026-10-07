"""Load the real engines. Imported lazily because it pulls in the heavy packages."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from .engines import Engines
from .stt import WhisperSTT
from .tts import PiperTTS


def load_engines(data_dir: Optional[str], stt_model: str = "base", tts_voice: str = "en_US-lessac-medium") -> Engines:
    root = Path(data_dir) if data_dir else Path.home() / ".friend" / "voice" / "models"
    root.mkdir(parents=True, exist_ok=True)
    return Engines(
        stt=WhisperSTT(stt_model, str(root / "whisper")),
        tts=PiperTTS(tts_voice, str(root / "piper")),
    )
