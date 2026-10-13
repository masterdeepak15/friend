# Searching the web

With Claude Code as the model, Friend lets Claude use its own **WebSearch** tool, so a question about today ("what is the share
market today?", news, prices, scores) is answered from what Claude finds, with the source named, and not from memory.

- On by default. Switch it off in Settings → Model (**Let Claude search the web**) or with the `claudeCode.webSearch` setting.
- Only searching. Claude gets no other built-in tool (no file, shell or page-opening tools), and a guest never gets this one.
- The search runs on Anthropic's side and is included in your Claude subscription. It adds to the tokens shown in Settings → Usage.
- It works from voice, chat, WhatsApp and scheduled tasks alike, with no browser open.
- Only the Claude Code model has this. Other models (Ollama, an OpenAI-style server, the Claude API) cannot search yet.