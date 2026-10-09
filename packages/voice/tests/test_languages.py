"""Hindi and Marathi: the recognizer is told how those languages are written, and mixed speech keeps English in Latin letters."""

from __future__ import annotations

import threading
from types import SimpleNamespace

from friend_voice import stt


class StubModel:
    """Answers like faster-whisper: segments and an info object; records how it was called."""

    def __init__(self, heard: str, language: str, again: str | None = None) -> None:
        self.heard = heard
        self.language = language
        self.again = again
        self.calls: list[dict] = []

    def transcribe(self, samples, **kwargs):
        self.calls.append(kwargs)
        forced = kwargs.get("language")
        text = self.again if (forced and self.again is not None) else self.heard
        return [SimpleNamespace(text=text)], SimpleNamespace(language=forced or self.language)


def make(model: StubModel) -> "stt.WhisperSTT":
    engine = object.__new__(stt.WhisperSTT)
    engine._model = model
    engine._lock = threading.Lock()
    return engine


def run(model: StubModel, language, monkeypatch=None) -> dict:
    original = stt.decode_audio
    stt.decode_audio = lambda data: SimpleNamespace(size=16000)  # one second of "audio"
    try:
        return make(model).transcribe(b"x", language)
    finally:
        stt.decode_audio = original


def test_english_is_left_alone() -> None:
    model = StubModel("open my files", "en")
    out = run(model, None)
    assert out["text"] == "open my files" and out["language"] == "en"
    assert len(model.calls) == 1 and "initial_prompt" not in model.calls[0]


def test_a_forced_hindi_or_marathi_gets_the_hint_that_keeps_english_words_in_latin_letters() -> None:
    for code in ("hi", "mr"):
        model = StubModel("x", code)
        run(model, code)
        assert len(model.calls) == 1
        assert model.calls[0]["initial_prompt"] == stt.HINT_PROMPTS[code]
        assert model.calls[0]["language"] == code


def test_hindi_heard_on_its_own_is_said_again_with_the_hint() -> None:
    model = StubModel("aaj ka weather", "hi", again="आज का weather बहुत अच्छा है")
    out = run(model, None)
    assert out["text"] == "आज का weather बहुत अच्छा है"
    assert out["language"] == "hi"
    assert len(model.calls) == 2
    assert model.calls[0]["language"] is None and "initial_prompt" not in model.calls[0]
    assert model.calls[1]["language"] == "hi" and model.calls[1]["initial_prompt"] == stt.HINT_PROMPTS["hi"]


def test_a_second_pass_that_hears_nothing_keeps_the_first_answer() -> None:
    model = StubModel("मुझे बताओ", "hi", again="")
    out = run(model, None)
    assert out["text"] == "मुझे बताओ"


def test_nothing_heard_is_not_run_twice() -> None:
    model = StubModel("", "hi")
    out = run(model, None)
    assert out["text"] == "" and len(model.calls) == 1


def test_other_languages_are_not_run_twice() -> None:
    model = StubModel("bonjour tout le monde", "fr")
    run(model, None)
    assert len(model.calls) == 1


def test_the_hints_are_written_in_devanagari_with_an_english_word_in_latin() -> None:
    for text in stt.HINT_PROMPTS.values():
        assert any("ऀ" <= ch <= "ॿ" for ch in text)
        assert "Meeting" in text
