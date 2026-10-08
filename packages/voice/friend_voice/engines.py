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


class Speaker(Protocol):
    def embed(self, audio: bytes) -> dict:
        """Return {"embedding": [float, ...] (unit length), "seconds": float}. Raises ValueError for too little speech."""


@dataclass
class Engines:
    stt: STT
    tts: TTS
    speaker: Optional[Speaker] = None


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
        text = audio[5:].split(b"|VOICE:")[0].decode("utf-8", "replace") if audio.startswith(b"TEXT:") else "hello from the fake engine"
        return {"text": text, "language": language or "en", "duration": round(len(audio) / 32000, 3)}


class FakeTTS:
    def synthesize(self, text: str, voice: Optional[str]) -> bytes:
        return wav_bytes(b"\x00\x00" * 2205)  # 0.1 s of silence


class FakeSpeaker:
    """A body containing `VOICE:<name>:<anything>` gets a vector derived from <name> plus a little noise."""

    DIM = 256

    def embed(self, audio: bytes) -> dict:
        import hashlib
        import math
        import random

        marker = audio.find(b"VOICE:")
        if marker < 0:
            raise ValueError("not enough speech to recognize a voice (fake)")
        rest = audio[marker + 6 :].split(b":", 1)
        name = rest[0]
        detail = rest[1] if len(rest) > 1 else b""
        base = random.Random(hashlib.sha256(name).digest()).gauss
        noise = random.Random(hashlib.sha256(name + b"|" + detail).digest()).gauss
        vec = [base(0, 1) + 0.15 * noise(0, 1) for _ in range(self.DIM)]
        norm = math.sqrt(sum(x * x for x in vec))
        return {"embedding": [round(x / norm, 6) for x in vec], "seconds": 3.0}


def FakeEngines() -> Engines:  # noqa: N802 - factory used like a class in tests
    return Engines(stt=FakeSTT(), tts=FakeTTS(), speaker=FakeSpeaker())
