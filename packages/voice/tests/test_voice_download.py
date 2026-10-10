"""A voice download that was cut off must never be taken for an installed voice."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

from friend_voice.tts import ensure_voice


def fake_piper(monkeypatch, behaviour):
    """Stands in for piper.download_voices.download_voice; `behaviour(voice, folder)` does the 'download'."""
    calls = []

    def download_voice(voice, folder, force_redownload=False):
        calls.append((voice, Path(folder)))
        behaviour(voice, Path(folder))

    module = types.ModuleType("piper.download_voices")
    module.download_voice = download_voice
    monkeypatch.setitem(sys.modules, "piper", types.ModuleType("piper"))
    monkeypatch.setitem(sys.modules, "piper.download_voices", module)
    return calls


def complete(voice, folder):
    (folder / f"{voice}.onnx").write_bytes(b"MODEL")
    (folder / f"{voice}.onnx.json").write_text("{}")


def test_a_voice_with_both_files_is_not_downloaded_again(tmp_path, monkeypatch):
    calls = fake_piper(monkeypatch, complete)
    (tmp_path / "v-1.onnx").write_bytes(b"x")
    (tmp_path / "v-1.onnx.json").write_text("{}")
    assert ensure_voice("v-1", tmp_path) == tmp_path / "v-1.onnx"
    assert calls == []


def test_a_model_without_its_config_is_downloaded_clean(tmp_path, monkeypatch):
    calls = fake_piper(monkeypatch, complete)
    (tmp_path / "mr_IN-google-medium.onnx").write_bytes(b"HALF")  # what an interrupted download leaves
    model = ensure_voice("mr_IN-google-medium", tmp_path)
    assert model.read_bytes() == b"MODEL"
    assert (tmp_path / "mr_IN-google-medium.onnx.json").exists()
    assert len(calls) == 1


def test_files_are_moved_in_only_when_the_download_finished_and_the_scratch_folder_is_removed(tmp_path, monkeypatch):
    seen = {}

    def during(voice, folder):
        seen["folder"] = folder
        complete(voice, folder)
        assert not (tmp_path / f"{voice}.onnx").exists()  # nothing in the real place until it is finished

    fake_piper(monkeypatch, during)
    ensure_voice("v-2", tmp_path)
    assert (tmp_path / "v-2.onnx").exists()
    assert not seen["folder"].exists()
    assert [p.name for p in tmp_path.iterdir()] == ["v-2.onnx", "v-2.onnx.json"]


def test_a_failed_download_leaves_nothing_half_done(tmp_path, monkeypatch):
    def broken(voice, folder):
        (folder / f"{voice}.onnx").write_bytes(b"HALF")
        raise OSError("connection reset")

    fake_piper(monkeypatch, broken)
    with pytest.raises(OSError):
        ensure_voice("v-3", tmp_path)
    assert list(tmp_path.iterdir()) == []  # no model, no scratch folder: the next try starts clean
