# Configurable, not hardcoded: Alexa and portfolio settings

**Why:** Friend is self-hosted for anyone (owner's rule, 2026-10-11). Values a different user would change must be settings with defaults equal to today's behaviour. Safety floors stay fixed.

**Settings added (all PIN-protected, refused for the assistant, validated and clamped, defaults in brackets):**

| Block | Setting | Range | Used by |
|---|---|---|---|
| `brokers` | `currencySymbol` ["₹"], `currencyName` ["rupees"], `numberLocale` ["en-IN"] | symbol ≤4 chars, name ≤20, a locale `Intl` knows | reports, tool text, spoken amounts |
| `brokers` | `concentrationPct` [30], `bigDropPct` [5] | 5–90, 1–50 | report warnings |
| `brokers` | `cacheSeconds` [30], `maxSchedules` [20], `maxTriesPerDay` [3] | 5–300, 1–50, 1–10 | portfolio cache, schedule limit, retries |
| `alexa` | `skillName` ["Friend Assistant"], `locales` [["en-IN","hi-IN"]] | name ≤50, subset of the supported locales | generated skill package |
| `alexa` | `answerSeconds` [6.5], `holdMinutes` [10], `permissionSeconds` [120] | 2–7.5, 1–60, 30–600 | engine budget, held answer, permission wait |
| `alexa` | `requestsPerMinute` [60], `maxDevices` [10] | 10–600, 1–50 | endpoint rate limit, allowed Echo list |
| `alexa` | `extraVoiceTools` [[]] | tool names | extra tools a voice may use |

**Fixed on purpose (safety floors, documented):** the assistant can never change these settings; PIN-level (T3) tools and PC, file, settings, plugin, camera and connector tools can never be added to `extraVoiceTools` (the policy checks this again at decision time); Alexa's own 8-second limit caps `answerSeconds` at 7.5; at most 20 Echos wait to be allowed (abuse floor).

**Stages (each ends green, committed):**
1. Brokers options: config, settings, money formatter from options, report thresholds, cache, schedule limit, retries; tests.
2. Alexa options: config, settings, engine/permission/devices/policy/gateway/package read them; tests.
3. Screens: Alexa "Advanced" and Zerodha "Report options" fields (changed fields only, after the PIN); tests.
4. Docs, full verification, release 0.1.26.

**Later (backlog):** report wording and spoken phrases per language as data files; more locales than en-IN and hi-IN.
