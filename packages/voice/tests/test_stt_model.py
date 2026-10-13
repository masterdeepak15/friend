"""Changing the listening model while Friend runs: the new model is loaded (and downloaded) and swapped in; a failure keeps the old one."""

import json
import threading
import urllib.error
import urllib.request

import pytest

from friend_voice.engines import FakeEngines
from friend_voice.server import make_server

TOKEN = "test-secret-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


class Stub:
    def __init__(self, name: str) -> None:
        self.name = name

    def transcribe(self, audio, language):
        return {"text": f"heard by {self.name}", "language": "en", "duration": 1.0}


def serve(load_stt):
    server, port = make_server(FakeEngines(), TOKEN, port=0, load_stt=load_stt)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{port}"


def call(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def swap(base, model, headers=AUTH):
    return call(base + "/stt-model", data=json.dumps({"model": model}).encode(), headers={**headers, "Content-Type": "application/json"})


def heard(base):
    return call(base + "/stt", data=b"TEXT:x", headers={**AUTH, "Content-Type": "audio/webm"})[1]["text"]


@pytest.fixture()
def running():
    made = []
    server, base = serve(lambda name: (made.append(name), Stub(name))[1])
    yield base, made
    server.shutdown()
    server.server_close()


def test_requires_the_token(running):
    base, made = running
    assert swap(base, "small", headers={})[0] == 401
    assert swap(base, "small", headers={"Authorization": "Bearer wrong"})[0] == 401
    assert made == []


def test_loads_the_model_and_uses_it_from_then_on(running):
    base, made = running
    assert heard(base) == "x"  # the original engine
    status, body = swap(base, "small")
    assert (status, body) == (200, {"ok": True, "model": "small"})
    assert made == ["small"]
    assert heard(base) == "heard by small"


def test_a_model_that_cannot_be_loaded_leaves_the_old_one_working():
    def boom(name):
        raise RuntimeError("no internet to download it")

    server, base = serve(boom)
    try:
        status, body = swap(base, "large-v3-turbo")
        assert status == 500 and "no internet" in body["error"]
        assert heard(base) == "x"
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("bad", ["", "../../x", "a b", "x;y", "m" * 81])
def test_refuses_names_that_are_not_models(running, bad):
    base, made = running
    assert swap(base, bad)[0] == 400
    assert made == []


def test_without_a_loader_it_says_so():
    server, base = serve(None)
    try:
        assert swap(base, "small")[0] == 501
    finally:
        server.shutdown()
        server.server_close()
