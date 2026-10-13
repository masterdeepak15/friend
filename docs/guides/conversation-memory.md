# Keeping the conversation from growing

With Claude Code as the model, Friend keeps **one long conversation** and Claude re-reads all of it for every answer. After a
few days it can hold hundreds of thousands of tokens, so even a small question counts as a lot (see Settings → Usage).

## What Friend does about it

- **Tidy up by itself** (on by default): before an answer, if the conversation is past the limit (default 100,000 tokens), Friend
  asks the model for short notes on it (what you were doing, decisions, preferences, open tasks), then starts a fresh
  conversation from those notes. You see "Tidying up my memory" for a moment.
- **Tidy up now**: the same, when you press it (Settings → Model, under the Claude Code settings).
- **Start fresh** (asks for your PIN): forgets the earlier conversation completely. Friend's saved notes and memory are kept.

The size shown is what Claude read for its last call. A fresh conversation starts near 36,000 tokens, which is Claude Code's own
base, so the limit cannot go below 50,000.

## What is kept and what is lost

Kept: your saved notes (memory), and the notes written when tidying up. Lost: the exact earlier wording. If the notes could not be
written (the model was busy or failed), nothing is changed and Friend tries again after ten minutes.

Models that are sent the recent messages each time (Ollama, an OpenAI-style server, the Claude API) have no conversation of their
own to tidy, so none of this applies to them.