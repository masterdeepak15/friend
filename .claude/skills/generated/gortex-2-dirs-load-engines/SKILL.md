---
name: gortex-2-dirs-load-engines
description: "Work in the . +2 dirs · load_engines area — 34 symbols across 10 files (91% cohesion)"
---

# . +2 dirs · load_engines

34 symbols | 10 files | 91% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `external-call::dep:faster_whisper.WhisperModel`
- `external-call::dep:piper.PiperVoice`
- `external-call::dep:piper.download_voices.download_voice`
- `external-call::stdlib:pytest`
- `packages/voice/friend_voice/engines.py`
- `packages/voice/friend_voice/models.py`
- `packages/voice/friend_voice/stt.py`
- `packages/voice/friend_voice/tts.py`
- `packages/voice/tests/test_real_roundtrip.py`

## Key Files

| File | Symbols |
|------|---------|
| `` | home, Lock, Path, pathlib.Path |
| `external-call::dep:faster_whisper.WhisperModel` | faster_whisper.WhisperModel |
| `external-call::dep:piper.PiperVoice` | piper.PiperVoice |
| `external-call::dep:piper.download_voices.download_voice` | piper.download_voices.download_voice |
| `external-call::stdlib:pytest` | pytest |
| `packages/voice/friend_voice/engines.py` | Engines |
| `packages/voice/friend_voice/models.py` | load_engines, stt_model, data_dir, tts_voice |
| `packages/voice/friend_voice/stt.py` | __init__, WhisperSTT, download_root, model_name |
| `packages/voice/friend_voice/tts.py` | default_voice, _voice, ensure_voice, text, synthesize, ... |
| `packages/voice/tests/test_real_roundtrip.py` | engines, test_tts_produces_a_valid_wav, engines, test_garbage_audio_raises_instead_of_hanging, engines |

## Connected Communities

- **. +1 dirs · wav_bytes** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-58")
explore(operation:"context", task:"understand . +2 dirs · load_engines", format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
