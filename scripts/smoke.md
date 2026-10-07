# Friend Phase 1 smoke checklist

Run against a built app (`pnpm build`) with a real Anthropic key. Tick each line by hand.

| # | Success criterion (spec section 1) | How to check | Result 2026-10-07 |
|---|---|---|---|
| 1 | First run creates the owner (password, PIN, assistant name) | Open `http://127.0.0.1:8787` on the PC, fill the setup screen | PASS (browser) |
| 2 | Log in, type a request, reply shows as captions on the stage | Sign in, press any key, send a message | PASS for login, typing, captions and the no-key notice; model reply needs a real key, covered by the scripted e2e test |
| 3 | Read tool runs without asking; shell asks on a client card; destructive needs PIN | Ask: "list my workspace", "run git status", "delete the folder x" | Covered by integration tests (`integration.test.ts`); live run with a key still to do |
| 4 | Agent shows, updates and hides objects and switches scenes | Ask: "show my disk usage as a stat card, then clear the screen" | Covered by integration and e2e tests; live run with a key still to do |
| 5 | Particle sphere animates idle, thinking, speaking and reacts to amplitude | Watch the sphere while sending a message | PASS for idle and phone layout (screenshots); thinking and speaking states unit-tested, brief to see by eye |
| 6 | A stranger without credentials reaches nothing | `curl` the WebSocket with no cookie: closes 4401; `POST /api/setup` after setup returns 403 | PASS (gateway and e2e tests) |
| 7 | Every tool call, approval and login is audited | `friend status`, then inspect `audit_log` in `~/.friend/friend.db` | PASS (integration test asserts rows) |
| 8 | Works at phone width and is ready for a domain | Resize to about 420 px wide; set `publicUrl`/`trustProxy` and put Caddy in front | Phone width PASS (screenshot, owner menu works); domain setup is config only, not exercised yet |

## Known gaps to close before calling Phase 1 shipped

- Live model run (rows 3 and 4) needs `friend config set apiKey <key>`.
- Thinking and speaking presence states were not captured in screenshots.
