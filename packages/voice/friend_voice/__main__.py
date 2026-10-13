"""Run the sidecar: python -m friend_voice --token SECRET [--port N] [--fake] [--data-dir DIR]."""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading

from .engines import FakeEngines
from .server import make_server


def main() -> int:
    ap = argparse.ArgumentParser(prog="friend_voice")
    ap.add_argument("--token", default=None, help="shared secret (prefer the FRIEND_VOICE_TOKEN environment variable: command lines are visible to other users)")
    ap.add_argument("--port", type=int, default=0, help="0 picks a free port")
    ap.add_argument("--fake", action="store_true", help="use stub engines (tests)")
    ap.add_argument("--data-dir", default=None, help="folder holding downloaded models")
    ap.add_argument("--stt-model", default="small")
    ap.add_argument("--tts-voice", default="en_US-lessac-medium")
    args = ap.parse_args()
    token = args.token or os.environ.get("FRIEND_VOICE_TOKEN")
    if not token:
        ap.error("a token is required: set FRIEND_VOICE_TOKEN (or pass --token)")

    if args.fake:
        engines = FakeEngines()
    else:
        from .models import load_engines  # imported lazily: needs the heavy packages

        engines = load_engines(args.data_dir, args.stt_model, args.tts_voice)

    server, port = make_server(engines, token, port=args.port)
    print(json.dumps({"ready": True, "port": port}), flush=True)

    # When the parent process goes away its end of our stdin closes: shut down instead of lingering.
    def watch_parent() -> None:
        try:
            sys.stdin.read()
        finally:
            server.shutdown()

    threading.Thread(target=watch_parent, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
