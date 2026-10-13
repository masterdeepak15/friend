# Hands-free: say the name

Instead of holding the key, say your assistant's name: **"Hey Maya, what's the weather?"** (use the name you chose when you set Friend up). "Hay", "hello", "hi", "okay" and the name alone all work.

- Turn it on in the owner menu (Esc, or press and hold the top-left corner): **Hands-free: off → on**. It is a choice for that browser only, and the browser shows its microphone indicator while it listens.
- Say the name and the request together, or say only the name: a short chime means Friend is listening, and you have about 8 seconds to ask.
- While Friend is speaking, or while you hold the key, hands-free waits.
- Everything said without the name is thrown away at once; nothing is stored or run.
- A hands-free request goes through the same checks as a held-key one: if you taught Friend your voice, a different voice is a guest, and a borderline one asks for your PIN.

## Music and video turn down while you talk

While you talk to Friend (holding the key, or after you said its name) and while Friend is speaking, music and video are turned
down to a quarter of how loud they were, and come back as they were when nothing is happening (a moment after Friend finishes,
so the sound does not jump up between sentences). It covers the music player, videos and YouTube on the Friend screen, and the
players on the PC's own speakers. It never changes the volume you chose.

Settings → Voice has the switch and the level (`friend config set voice.duck false`, `voice.duckPercent 40`). If the screen
closes while the sound is down, it is brought back at once.

## When it mishears

- Far from the microphone, or in Hindi and Marathi, pick a bigger **Listening model** in Settings → Voice (Small is the default; Large (turbo) is best for Marathi but slow on a PC without a graphics card). Friend downloads it in the background, keeps listening with the old one meanwhile, and tells you when it is ready. No restart and no commands.
- The name should be easy to say. A name Whisper often writes differently (for example in Devanagari) may not be recognised yet: the name is matched in Latin letters, allowing one wrong letter in names of four or more letters.
- Needs the voice add-on (`friend voice setup`) and a secure page (localhost or HTTPS) for the microphone.

Hands-free in a background listener on the PC (no browser open) is not built yet.
