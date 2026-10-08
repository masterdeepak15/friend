"""Hardening found in review: voice names, hostile input, timeouts, token handling."""

import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from friend_voice.engines import FakeEngines
from friend_voice.server import make_server
from friend_voice.tts import check_voice_name, ensure_voice

TOKEN = "hardening-token"
ROOT = Path(__file__).resolve().parent.parent
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def server():
    srv, port = make_server(FakeEngines(), TOKEN, port=0, max_body=1000, io_timeout=1)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield port
    srv.shutdown()
    srv.server_close()


def post(port, path, data, headers=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers={**AUTH, **(headers or {})}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# ------------------------------------------------------------ voice names

@pytest.mark.parametrize("bad", ["../../evil", "..\\..\\evil", "a/b", "a\\b", "", " ", "x" * 200, "voice.onnx", "C:\\x", "a b", "a\x00b"])
def test_unsafe_voice_names_are_rejected(bad):
    with pytest.raises(ValueError):
        check_voice_name(bad)


@pytest.mark.parametrize("good", ["en_US-lessac-medium", "hi_IN-pratham-medium", "voice1", "a-b_c"])
def test_normal_voice_names_are_accepted(good):
    assert check_voice_name(good) == good


def test_ensure_voice_never_leaves_the_models_folder(tmp_path):
    with pytest.raises(ValueError):
        ensure_voice("../../outside", tmp_path / "models")
    assert not (tmp_path / "outside.onnx").exists()


def test_the_server_rejects_an_unsafe_voice_before_touching_the_engine(server):
    status, body = post(server, "/tts", json.dumps({"text": "hi", "voice": "../../evil"}).encode(), {"Content-Type": "application/json"})
    assert status == 400
    assert "voice" in json.loads(body)["error"].lower()
    status, _ = post(server, "/tts", json.dumps({"text": "hi", "voice": "en_US-lessac-medium"}).encode(), {"Content-Type": "application/json"})
    assert status == 200


# ------------------------------------------------------------ hostile audio

def test_a_too_long_recording_is_a_client_error_not_a_server_crash(server):
    status, body = post(server, "/stt", b"LONG", {"Content-Type": "audio/webm"})
    assert status == 400
    assert "long" in json.loads(body)["error"].lower()


# ------------------------------------------------------------ socket behavior

def test_a_request_without_content_length_gets_411_and_the_connection_closes(server):
    s = socket.create_connection(("127.0.0.1", server), timeout=3)
    s.sendall(
        b"POST /stt HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + TOKEN.encode() + b"\r\n"
        b"Transfer-Encoding: chunked\r\n\r\n4\r\nTEXT\r\n0\r\n\r\n"
    )
    data = s.recv(4096)
    assert b" 411 " in data.split(b"\r\n")[0]
    assert b"close" in data.lower()
    s.close()


def test_a_connection_that_stalls_mid_request_is_dropped(server):
    s = socket.create_connection(("127.0.0.1", server), timeout=5)
    s.sendall(b"POST /stt HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n")  # never finishes the headers
    started = time.time()
    try:
        data = s.recv(4096)
    except OSError:
        data = b""
    assert data == b"" or b"408" in data or b"400" in data
    assert time.time() - started < 4  # io_timeout is 1 s in this fixture
    s.close()


# ------------------------------------------------------------ token handling

def run_cli(env_extra, args):
    env = {k: v for k, v in os.environ.items() if k != "FRIEND_VOICE_TOKEN"}
    env.update(env_extra)
    return subprocess.Popen(
        [sys.executable, "-m", "friend_voice", *args],
        cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )


def test_the_token_can_come_from_the_environment_instead_of_the_command_line():
    proc = run_cli({"FRIEND_VOICE_TOKEN": TOKEN}, ["--fake"])
    try:
        info = json.loads(proc.stdout.readline())
        req = urllib.request.Request(f"http://127.0.0.1:{info['port']}/health", headers=AUTH)
        assert urllib.request.urlopen(req, timeout=5).status == 200
    finally:
        proc.stdin.close()
        assert proc.wait(timeout=10) == 0


def test_it_refuses_to_start_without_any_token():
    proc = run_cli({}, ["--fake"])
    try:
        assert proc.wait(timeout=10) != 0
        assert "token" in proc.stderr.read().lower()
    finally:
        if proc.poll() is None:
            proc.kill()
