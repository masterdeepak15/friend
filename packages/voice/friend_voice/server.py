"""Tiny authenticated HTTP API around the speech engines (standard library only)."""

from __future__ import annotations

import hmac
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Tuple
from urllib.parse import parse_qs, urlparse

from .engines import Engines
from .tts import check_voice_name

MAX_TTS_CHARS = 2000


def make_server(
    engines: Engines, token: str, port: int = 0, max_body: int = 4_000_000, io_timeout: float = 30
) -> Tuple[ThreadingHTTPServer, int]:
    """Create (but do not start) a server bound to 127.0.0.1. Returns (server, actual_port)."""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = io_timeout  # a client that stalls mid-request is dropped instead of holding a thread forever

        def log_message(self, *args) -> None:  # keep stdout clean for the ready line
            pass

        # ---- helpers -------------------------------------------------------
        def _authorized(self) -> bool:
            given = self.headers.get("Authorization", "")
            return hmac.compare_digest(given.encode(), f"Bearer {token}".encode())

        def _send(self, status: int, body: bytes, content_type: str, close: bool = False) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            if close:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, obj: dict, close: bool = False) -> None:
            self._send(status, json.dumps(obj).encode(), "application/json; charset=utf-8", close)

        def _read_body(self) -> bytes | None:
            """Read the request body, or answer with an error and return None."""
            if self.headers.get("Content-Length") is None:
                # chunked or length-less bodies are not supported; close so unread bytes cannot confuse the next request
                self._json(411, {"error": "Content-Length is required"}, close=True)
                return None
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self._json(400, {"error": "bad Content-Length"}, close=True)
                return None
            if length > max_body:
                # Read (and discard) a bounded amount so the client sees the 413 instead of a connection reset.
                self.rfile.read(min(length, 4 * max_body))
                self._json(413, {"error": "body too large"}, close=True)
                return None
            if length <= 0:
                self._json(400, {"error": "empty body"})
                return None
            return self.rfile.read(length)

        # ---- routes --------------------------------------------------------
        def do_GET(self) -> None:  # noqa: N802
            if not self._authorized():
                return self._json(401, {"error": "unauthorized"})
            if urlparse(self.path).path == "/health":
                return self._json(200, {"ok": True})
            self._json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            # authenticate before reading any of the body
            if not self._authorized():
                self._drain(64 * 1024)
                return self._json(401, {"error": "unauthorized"}, close=True)
            url = urlparse(self.path)
            if url.path == "/stt":
                return self._stt(parse_qs(url.query))
            if url.path == "/tts":
                return self._tts()
            if url.path == "/embed":
                return self._embed()
            self._drain(64 * 1024)
            self._json(404, {"error": "not found"}, close=True)

        def _drain(self, limit: int) -> None:
            """Discard up to `limit` bytes of the request body so the client sees our reply, not a reset."""
            try:
                n = min(int(self.headers.get("Content-Length", "0")), limit)
            except ValueError:
                return
            if n > 0:
                self.rfile.read(n)

        def _stt(self, query: dict) -> None:
            audio = self._read_body()
            if audio is None:
                return
            language = (query.get("language") or [None])[0]
            try:
                result = engines.stt.transcribe(audio, language)
                if query.get("embed") == ["1"]:
                    # the voiceprint of the same recording; too little speech still gives a transcript
                    result["embedding"] = None
                    if engines.speaker is not None:
                        try:
                            result["embedding"] = engines.speaker.embed(audio)["embedding"]
                        except ValueError as e:
                            result["embeddingError"] = str(e)
                self._json(200, result)
            except ValueError as e:  # bad input (e.g. a recording that is too long): the caller's problem
                self._json(400, {"error": str(e)})
            except Exception as e:  # engine failures are reported, never crash the server
                self._json(500, {"error": str(e)})

        def _embed(self) -> None:
            audio = self._read_body()
            if audio is None:
                return
            if engines.speaker is None:
                return self._json(501, {"error": "the speaker model is not available"})
            try:
                self._json(200, engines.speaker.embed(audio))
            except ValueError as e:
                self._json(400, {"error": str(e)})
            except Exception as e:
                self._json(500, {"error": str(e)})

        def _tts(self) -> None:
            raw = self._read_body()
            if raw is None:
                return
            try:
                req = json.loads(raw)
                text = req["text"]
                voice = req.get("voice")
            except (ValueError, KeyError, TypeError):
                return self._json(400, {"error": "expected JSON with a text field"})
            if not isinstance(text, str) or not text.strip():
                return self._json(400, {"error": "text must be a non-empty string"})
            if len(text) > MAX_TTS_CHARS:
                return self._json(413, {"error": f"text longer than {MAX_TTS_CHARS} characters"})
            if voice is not None:
                try:
                    check_voice_name(voice)
                except ValueError as e:
                    return self._json(400, {"error": str(e)})
            try:
                self._send(200, engines.tts.synthesize(text, voice), "audio/wav")
            except ValueError as e:
                self._json(400, {"error": str(e)})
            except Exception as e:
                self._json(500, {"error": str(e)})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server, server.server_address[1]
