import json
import math
import threading
import urllib.error
import urllib.request

import pytest

from friend_voice.engines import FakeEngines
from friend_voice.server import make_server

TOKEN = "speaker-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def cosine(a, b):
    return sum(x * y for x, y in zip(a, b)) / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


@pytest.fixture()
def port():
    srv, p = make_server(FakeEngines(), TOKEN, port=0, max_body=100_000)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield p
    srv.shutdown()
    srv.server_close()


def post(port, path, data):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers={**AUTH, "Content-Type": "audio/webm"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_embed_returns_a_unit_vector_and_the_speech_length(port):
    status, body = post(port, "/embed", b"VOICE:alice:one")
    assert status == 200
    assert len(body["embedding"]) == 256
    assert abs(math.sqrt(sum(x * x for x in body["embedding"])) - 1) < 1e-3
    assert body["seconds"] > 0


def test_the_same_speaker_is_close_and_different_speakers_are_far(port):
    a1 = post(port, "/embed", b"VOICE:alice:first phrase")[1]["embedding"]
    a2 = post(port, "/embed", b"VOICE:alice:second phrase")[1]["embedding"]
    b1 = post(port, "/embed", b"VOICE:bob:first phrase")[1]["embedding"]
    assert cosine(a1, a2) > 0.9
    assert cosine(a1, b1) < 0.4


def test_too_little_speech_is_a_client_error(port):
    status, body = post(port, "/embed", b"SHORT")
    assert status == 400
    assert "speech" in body["error"].lower()


def test_stt_can_return_the_voiceprint_in_the_same_request(port):
    status, body = post(port, "/stt?embed=1", b"TEXT:open the folder|VOICE:alice:x")
    assert status == 200
    assert body["text"] == "open the folder"
    assert len(body["embedding"]) == 256


def test_stt_without_the_flag_has_no_embedding(port):
    _, body = post(port, "/stt", b"TEXT:hello|VOICE:alice:x")
    assert "embedding" not in body


def test_stt_still_returns_text_when_the_audio_is_too_short_to_identify(port):
    status, body = post(port, "/stt?embed=1", b"TEXT:hi")
    assert status == 200
    assert body["text"] == "hi"
    assert body["embedding"] is None
    assert "speech" in body["embeddingError"].lower()


def test_embed_needs_the_token(port):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/embed", data=b"VOICE:a:x", method="POST")
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(req, timeout=5)
    assert e.value.code == 401


def test_a_server_without_a_speaker_model_says_so():
    from friend_voice.engines import Engines, FakeSTT, FakeTTS

    srv, p = make_server(Engines(stt=FakeSTT(), tts=FakeTTS()), TOKEN, port=0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        status, body = post(p, "/embed", b"VOICE:a:x")
        assert status == 501
        assert "speaker" in body["error"].lower()
        status, body = post(p, "/stt?embed=1", b"TEXT:hello")
        assert status == 200 and body["embedding"] is None
    finally:
        srv.shutdown()
        srv.server_close()
