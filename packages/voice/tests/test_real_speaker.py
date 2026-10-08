"""Real speaker model: different Piper voices stand in for different people."""

import math
from pathlib import Path

import pytest

pytest.importorskip("sherpa_onnx", reason="sherpa-onnx not installed")
pytest.importorskip("piper", reason="piper-tts not installed")

from friend_voice.engines import wav_bytes  # noqa: E402
from friend_voice.models import load_engines  # noqa: E402

MODELS = Path(__file__).resolve().parent.parent / ".models"
VOICES = ["en_US-lessac-medium", "en_US-amy-medium"]
PHRASES = [
    "Please open the project folder and show me the latest changes.",
    "What is the weather going to be like this evening in the city?",
    "Remind me to call the bank tomorrow morning at nine o'clock.",
]


def cosine(a, b):
    return sum(x * y for x, y in zip(a, b)) / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


@pytest.fixture(scope="module")
def eng():
    for v in VOICES:
        if not (MODELS / "piper" / f"{v}.onnx").exists():
            pytest.skip(f"voice {v} not downloaded")
    return load_engines(str(MODELS), "base", VOICES[0])


@pytest.fixture(scope="module")
def prints(eng):
    out = {}
    for v in VOICES:
        out[v] = [eng.speaker.embed(eng.tts.synthesize(p, v))["embedding"] for p in PHRASES]
    return out


def test_the_model_is_loaded_and_embeddings_are_unit_length(eng, prints):
    assert eng.speaker is not None
    e = prints[VOICES[0]][0]
    assert len(e) == 256
    assert abs(math.sqrt(sum(x * x for x in e)) - 1) < 1e-3


def test_the_same_voice_saying_different_things_scores_high(prints):
    a = prints[VOICES[0]]
    for i in range(3):
        for j in range(i + 1, 3):
            assert cosine(a[i], a[j]) > 0.75


def test_a_different_voice_scores_below_the_accept_threshold(prints):
    owner, other = prints[VOICES[0]], prints[VOICES[1]]
    for x in owner:
        for y in other:
            assert cosine(x, y) < 0.72


def test_silence_and_very_short_audio_are_refused(eng):
    with pytest.raises(ValueError, match="speech"):
        eng.speaker.embed(wav_bytes(b"\x00\x00" * 16000 * 3, 16000))  # 3 s of silence
    with pytest.raises(ValueError, match="speech"):
        eng.speaker.embed(eng.tts.synthesize("Hi.", None)[:30_000])  # a fraction of a second


def test_audio_longer_than_the_limit_is_refused(eng):
    with pytest.raises(ValueError, match="longer"):
        eng.speaker.embed(wav_bytes(b"\x01\x00" * 16000 * 100, 16000))
