"""Engine interfaces and the stub engines used by tests and `--fake`."""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Optional, Protocol


class STT(Protocol):
    def transcribe(self, audio: bytes, language: Optional[str]) -> dict:
        """Return {"text": str, "language": str, "duration": float}."""


class TTS(Protocol):
    def synthesize(self, text: str, voice: Optional[str]) -> bytes:
        """Return a complete WAV file."""


@dataclass
class Engines:
    stt: STT
    tts: TTS


def wav_bytes(pcm16: bytes, sample_rate: int = 22050) -> bytes:
    """Wrap 16-bit mono PCM in a WAV container."""
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm16)) + b"WAVE"
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
    data = b"data" + struct.pack("<I", len(pcm16)) + pcm16
    return header + fmt + data


class FakeSTT:
    """Treats a body that starts with b"TEXT:" as the transcript; b"FAIL" raises."""

    def transcribe(self, audio: bytes, language: Optional[str]) -> dict:
        if audio.startswith(b"FAIL"):
            raise RuntimeError("fake stt failure")
        if audio.startswith(b"LONG"):
            raise ValueError("recording longer than 90 seconds")
        text = audio[5:].decode("utf-8", "replace") if audio.startswith(b"TEXT:") else "hello from the fake engine"
        return {"text": text, "language": language or "en", "duration": round(len(audio) / 32000, 3)}


class FakeTTS:
    def synthesize(self, text: str, voice: Optional[str]) -> bytes:
        return wav_bytes(b"\x00\x00" * 2205)  # 0.1 s of silence


def FakeEngines() -> Engines:  # noqa: N802 - factory used like a class in tests
    return Engines(stt=FakeSTT(), tts=FakeTTS())
