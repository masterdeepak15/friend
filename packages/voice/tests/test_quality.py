"""Recognition quality when the speaker is far from the microphone: quiet audio is levelled, and doubtful guesses are dropped."""

from __future__ import annotations

import threading
from types import SimpleNamespace

import numpy as np

from friend_voice import stt


def tone(amplitude: float, seconds: float = 1.0) -> "np.ndarray":
    t = np.arange(int(stt.SAMPLE_RATE * seconds)) / stt.SAMPLE_RATE
    return (amplitude * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def rms(x) -> float:
    return float(np.sqrt(np.mean(np.square(x))))


def test_quiet_speech_from_across_the_room_is_brought_up() -> None:
    quiet = tone(0.01)
    loud = stt.level(quiet)
    assert rms(loud) > rms(quiet) * 4
    assert float(np.max(np.abs(loud))) <= 0.99  # never clips


def test_speech_that_is_already_loud_enough_is_left_alone() -> None:
    ok = tone(0.3)
    assert np.allclose(stt.level(ok), ok)


def test_silence_is_not_turned_into_noise() -> None:
    silent = np.zeros(16000, dtype=np.float32)
    assert float(np.max(np.abs(stt.level(silent)))) == 0.0
    hiss = tone(0.0003)  # a room with nobody speaking
    assert rms(stt.level(hiss)) < 0.01


def test_the_gain_is_capped() -> None:
    assert rms(stt.level(tone(0.002))) <= rms(tone(0.002)) * stt.MAX_GAIN * 1.01


class Model:
    def __init__(self, segments) -> None:
        self.segments = segments
        self.calls: list[dict] = []

    def transcribe(self, samples, **kwargs):
        self.calls.append(kwargs)
        return self.segments, SimpleNamespace(language=kwargs.get("language") or "en")


def seg(text: str, no_speech: float = 0.0, logprob: float = -0.2):
    return SimpleNamespace(text=text, no_speech_prob=no_speech, avg_logprob=logprob)


def heard(segments) -> tuple[dict, Model]:
    model = Model(segments)
    engine = object.__new__(stt.WhisperSTT)
    engine._model = model
    engine._lock = threading.Lock()
    original = stt.decode_audio
    stt.decode_audio = lambda data: SimpleNamespace(size=16000)
    try:
        return engine.transcribe(b"x", "en"), model
    finally:
        stt.decode_audio = original


def test_a_confident_sentence_is_kept() -> None:
    out, _ = heard([seg("open my files")])
    assert out["text"] == "open my files"


def test_a_guess_made_over_noise_is_dropped() -> None:
    out, _ = heard([seg("open my files"), seg("ترجمة نانسي قنقر", no_speech=0.9, logprob=-1.4)])
    assert out["text"] == "open my files"


def test_a_very_doubtful_segment_is_dropped_even_when_speech_was_likely() -> None:
    out, _ = heard([seg("what is the weather"), seg("ا ا ا ا", no_speech=0.2, logprob=-2.4)])
    assert out["text"] == "what is the weather"


def test_nothing_but_doubt_is_nothing_heard() -> None:
    out, _ = heard([seg("شكرا", no_speech=0.8, logprob=-1.6)])
    assert out["text"] == ""


def test_the_model_is_asked_to_search_harder_and_to_give_up_on_noise() -> None:
    _, model = heard([seg("hello")])
    call = model.calls[0]
    assert call["beam_size"] >= 5
    assert call["no_speech_threshold"] == stt.NO_SPEECH_PROB
    assert call["log_prob_threshold"] == stt.MIN_LOGPROB
    assert call["compression_ratio_threshold"] <= 2.4
    assert call["condition_on_previous_text"] is False
