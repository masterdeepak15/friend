import json
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from friend_voice.engines import FakeEngines
from friend_voice.server import make_server

TOKEN = "test-secret-token"
ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture()
def base():
    server, port = make_server(FakeEngines(), TOKEN, port=0, max_body=1000)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    server.shutdown()
    server.server_close()


def call(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


AUTH = {"Authorization": f"Bearer {TOKEN}"}


def test_health_requires_the_token(base):
    assert call(base + "/health")[0] == 401
    assert call(base + "/health", headers={"Authorization": "Bearer wrong"})[0] == 401
    status, _, body = call(base + "/health", headers=AUTH)
    assert status == 200
    assert json.loads(body)["ok"] is True


def test_stt_returns_text_language_and_duration(base):
    status, headers, body = call(base + "/stt", data=b"TEXT:hello there", headers={**AUTH, "Content-Type": "audio/webm"})
    assert status == 200
    assert headers["Content-Type"].startswith("application/json")
    out = json.loads(body)
    assert out["text"] == "hello there"
    assert out["language"] == "en"
    assert out["duration"] >= 0


def test_stt_passes_the_language_hint(base):
    _, _, body = call(base + "/stt?language=hi", data=b"TEXT:namaste", headers={**AUTH, "Content-Type": "audio/webm"})
    assert json.loads(body)["language"] == "hi"


def test_stt_rejects_an_oversize_body_with_413(base):
    status, _, _ = call(base + "/stt", data=b"x" * 2000, headers={**AUTH, "Content-Type": "audio/webm"})
    assert status == 413


def test_stt_rejects_an_empty_body_with_400(base):
    status, _, _ = call(base + "/stt", data=b"", headers={**AUTH, "Content-Type": "audio/webm"})
    assert status == 400


def test_tts_returns_wav_audio(base):
    payload = json.dumps({"text": "Good evening"}).encode()
    status, headers, body = call(base + "/tts", data=payload, headers={**AUTH, "Content-Type": "application/json"})
    assert status == 200
    assert headers["Content-Type"] == "audio/wav"
    assert body[:4] == b"RIFF"


def test_tts_rejects_missing_text_and_invalid_json(base):
    h = {**AUTH, "Content-Type": "application/json"}
    assert call(base + "/tts", data=b"{}", headers=h)[0] == 400
    assert call(base + "/tts", data=b"not json", headers=h)[0] == 400
    assert call(base + "/tts", data=json.dumps({"text": "x" * 3000}).encode(), headers={**h})[0] in (400, 413)


def test_unauthenticated_requests_are_refused_before_reading_the_body(base):
    assert call(base + "/stt", data=b"TEXT:hi")[0] == 401
    assert call(base + "/tts", data=b"{}")[0] == 401


def test_unknown_paths_are_404_and_wrong_methods_405(base):
    assert call(base + "/nope", headers=AUTH)[0] == 404
    assert call(base + "/stt", headers=AUTH)[0] in (404, 405)


def test_engine_errors_become_500_json(base):
    status, _, body = call(base + "/stt", data=b"FAIL", headers={**AUTH, "Content-Type": "audio/webm"})
    assert status == 500
    assert "error" in json.loads(body)


def test_the_cli_prints_a_ready_line_with_the_port():
    proc = subprocess.Popen(
        [sys.executable, "-m", "friend_voice", "--token", TOKEN, "--fake"],
        cwd=ROOT,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        line = proc.stdout.readline()
        info = json.loads(line)
        assert info["ready"] is True
        assert isinstance(info["port"], int) and info["port"] > 0
        status, _, _ = call(f"http://127.0.0.1:{info['port']}/health", headers=AUTH)
        assert status == 200
    finally:
        proc.stdin.close()  # closing stdin tells the sidecar its parent is gone
        assert proc.wait(timeout=10) == 0
