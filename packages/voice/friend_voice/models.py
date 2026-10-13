"""Load the real engines. Imported lazily because it pulls in the heavy packages."""

from __future__ import annotations

import hashlib
import os
import tempfile
import urllib.request
from pathlib import Path
from typing import Optional

from .engines import Engines
from .stt import WhisperSTT
from .tts import PiperTTS

SPEAKER_MODEL = "wespeaker_en_voxceleb_resnet34.onnx"
SPEAKER_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/" + SPEAKER_MODEL
#: Pinned so a replaced or corrupted download is refused instead of loaded.
SPEAKER_SHA256 = "5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def ensure_speaker_model(directory: Path, url: str = SPEAKER_URL, sha256: str = SPEAKER_SHA256) -> Path:
    """Return the path to the speaker model, downloading it when missing or when its hash does not match."""
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / SPEAKER_MODEL
    if target.exists() and _sha256(target) == sha256:
        return target
    fd, tmp_name = tempfile.mkstemp(dir=directory, suffix=".part")
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        urllib.request.urlretrieve(url, tmp)  # noqa: S310 - a fixed https URL
        if _sha256(tmp) != sha256:
            raise RuntimeError("the downloaded speaker model does not match its expected checksum")
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
    return target


def load_engines(data_dir: Optional[str], stt_model: str = "small", tts_voice: str = "en_US-lessac-medium") -> Engines:
    root = Path(data_dir) if data_dir else Path.home() / ".friend" / "voice" / "models"
    root.mkdir(parents=True, exist_ok=True)
    speaker = None
    try:
        from .speaker import SherpaSpeaker

        speaker = SherpaSpeaker(str(ensure_speaker_model(root / "speaker")))
    except ImportError:
        speaker = None  # sherpa-onnx is not installed: voice works, speaker recognition does not
    return Engines(
        stt=WhisperSTT(stt_model, str(root / "whisper")),
        tts=PiperTTS(tts_voice, str(root / "piper")),
        speaker=speaker,
    )
