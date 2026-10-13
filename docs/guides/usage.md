# Seeing how many tokens Friend uses

Friend writes down how many tokens each answer used, so you can see it day by day.

- **Settings → Usage** (also in the orb menu): totals for 7, 30 or 90 days, a bar for each day, the exact numbers per day,
  and the split by model and by where the request came from (voice, chat, scheduled tasks, WhatsApp/Telegram messages).
- In a terminal: `friend usage` (last 7 days) or `friend usage --days 30`.

## What is kept

Only the day, the model, where the request came from, and two numbers (tokens sent, tokens written back). **Never what was said
or answered.** The numbers are what the model reports for each answer; if a model does not report them, nothing is written.

- With Claude Code, the "sent" number includes the conversation Claude re-reads from its cache, so it is much larger than what you typed.
- Counts older than a year are removed when Friend starts.
- `friend usage clear` (or Settings → Usage → Clear saved counts) removes all of them now.
- A "day" is the date on this computer's own clock.