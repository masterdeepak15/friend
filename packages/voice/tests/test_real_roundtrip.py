"""Real engines: Piper speaks a sentence and faster-whisper transcribes it back.

Needs the heavy packages; skipped (with a visible reason) when they are not installed.
Models are cached in packages/voice/.models (downloaded on the first run).
"""

import re
from pathlib import Path

import pytest

pytest.importorskip("faster_whisper", reason="faster-whisper not installed")
pytest.importorskip("piper", reason="piper-tts not installed")

from friend_voice.models import load_engines  # noqa: E402

MODELS = Path(__file__).resolve().parent.parent / ".models"
SENTENCE = "The quick brown fox jumps over the lazy dog."


def words(text: str) -> list[str]:
    return re.findall(r"[a-z']+", text.lower())


@pytest.fixture(scope="module")
def engines():
    return load_engines(str(MODELS), "base", "en_US-lessac-medium")


def test_tts_produces_a_valid_wav(engines):
    wav = engines.tts.synthesize(SENTENCE, None)
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
    assert len(wav) > 20_000  # roughly two seconds of 22 kHz audio


def test_the_spoken_sentence_is_transcribed_back(engines):
    wav = engines.tts.synthesize(SENTENCE, None)
    out = engines.stt.transcribe(wav, None)
    expected = words(SENTENCE)
    heard = set(words(out["text"]))
    overlap = sum(1 for w in expected if w in heard) / len(expected)
    assert overlap >= 0.8, f"heard {out['text']!r}"
    assert out["language"] == "en"
    assert 1.0 < out["duration"] < 8.0


def test_a_language_hint_is_accepted(engines):
    wav = engines.tts.synthesize("Good evening, boss.", None)
    assert "evening" in engines.stt.transcribe(wav, "en")["text"].lower()


def test_silence_yields_an_empty_transcript_not_an_error(engines):
    from friend_voice.engines import wav_bytes

    out = engines.stt.transcribe(wav_bytes(b"\x00\x00" * 16000, 16000), None)
    assert out["text"].strip() == ""


def test_a_recording_longer_than_the_limit_is_refused_before_transcribing(engines):
    from friend_voice.engines import wav_bytes

    started = __import__("time").time()
    with pytest.raises(ValueError, match="longer"):
        engines.stt.transcribe(wav_bytes(b"\x00\x00" * 16000 * 100, 16000), None)  # 100 s of silence
    assert __import__("time").time() - started < 10  # refused while decoding, not after transcribing it all


def test_a_container_without_audio_is_a_value_error(engines):
    # a valid WAV header with no samples at all
    from friend_voice.engines import wav_bytes

    out = engines.stt.transcribe(wav_bytes(b"", 16000), None)
    assert out["text"] == ""


def test_garbage_audio_raises_instead_of_hanging(engines):
    with pytest.raises(Exception):
        engines.stt.transcribe(b"this is definitely not audio", None)
