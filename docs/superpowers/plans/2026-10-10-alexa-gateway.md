# Alexa Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner talk to Friend from their own Echo devices through a self-hosted Alexa custom skill (English India and Hindi India), read-only by voice, with permissions asked on Telegram/WhatsApp.

**Architecture:** Friend exposes `POST /api/alexa`, the skill's endpoint. Every request is verified (Amazon signature, timestamp, application id, allowed Amazon user) before anything is read from it. Fixed intents are answered directly from Friend's tools; open questions go to the assistant under a new `voice-device` trust level that can only read, with a 6.5 s budget and a "still working / is it ready" holder. An Alexa integration (Plugins screen) shows the endpoint, the skill package to paste into the Alexa console, and the waiting/allowed Echo devices.

**Tech Stack:** TypeScript, Fastify, node:crypto (`X509Certificate`), zod, vitest, React (web).

**Spec:** `docs/superpowers/specs/2026-10-10-alexa-gateway-design.md`

## Global Constraints

- Endpoint path `/api/alexa`; Amazon calls it over HTTPS port 443 with a CA-signed certificate (self-signed only for tests).
- Signature: headers `SignatureCertChainUrl` and `Signature-256`; certificate URL must be `https`, host `s3.amazonaws.com`, path starting `/echo.api/`, port 443 if given; certificate valid now, SAN `echo-api.amazon.com`, chain to a trusted root; RSA SHA-256 over the raw body. Timestamp tolerance 150 seconds. Failed checks answer HTTP 400.
- Wrong `applicationId` or a user not on the allowed list: no assistant answer (400 for application, a fixed "not allowed yet" speech for an unknown user, recorded as waiting).
- Alexa waits about 8 seconds; Friend answers within 6.5 seconds or says "Still working. Ask me if it is ready." Result kept 10 minutes.
- Speech at most 8000 characters; response at most 120 KB; plain text speech only (escape `& < >`); Devanagari allowed.
- Invocation name: two or more lower-case words, no "alexa/amazon/echo/skill/app/ask/tell/open/start/run/enable"; default `<assistantName> assistant` lower-cased.
- Locales `en-IN` and `hi-IN`. No Marathi.
- Voice-device trust: read tools only; T2 actions need a "YES" reply on Telegram/WhatsApp within 5 minutes; T3 (PIN) actions are refused; no linked messaging app means permission requests are skipped.
- Secrets/privacy: the audit log records the intent and device, never the spoken text; the skill id and allowed user ids are not secrets but are PIN-protected to change; the assistant cannot change Alexa settings (refused for the agent).
- Version bump and release at the end (0.1.24 unless a later number is already published).

## Review Focus

1. A request older than 150 s, or replayed with a changed body, is refused (400) — Task 1.
2. A request meant for another skill (`applicationId` mismatch) never reaches the assistant — Task 6.
3. An unknown Amazon user gets no answer from the assistant, is listed once as waiting, and the waiting list cannot grow without bound — Task 3 and Task 6.
4. A model that never answers: the 6.5 s budget fires, a second question while one is pending does not start another, and "is it ready" returns the finished answer once — Task 2.
5. Reply text containing `&`, `<`, newlines, rupee signs, Devanagari, or 20,000 characters is spoken safely and truncated — Task 2.
6. `SessionEndedRequest` and `AMAZON.StopIntent` end quietly with no speech and no error — Task 2.

---

### Task 1: Request verifier

**Files:**
- Create: `packages/server/src/alexa/verify.ts`
- Test: `packages/server/src/alexa/verify.test.ts`

**Interfaces:**
- Produces:
  - `interface VerifyOptions { headers: Record<string, string | string[] | undefined>; rawBody: Buffer; now: number; fetchCert: (url: string) => Promise<string>; roots?: string[] }` (`roots`: PEM roots to trust; default `tls.rootCertificates`)
  - `type Verified = { ok: true; body: AlexaRequestBody } | { ok: false; status: 400; reason: string }`
  - `verifyAlexaRequest(o: VerifyOptions): Promise<Verified>`
  - `interface AlexaRequestBody { version: string; session?: { user?: { userId?: string }; application?: { applicationId?: string }; new?: boolean; sessionId?: string }; context?: { System?: { application?: { applicationId?: string }; user?: { userId?: string }; device?: { deviceId?: string } } }; request: { type: string; requestId?: string; timestamp: string; locale?: string; intent?: { name: string; slots?: Record<string, { value?: string }> } } }`
  - `testAlexaSigner()` (in the test file's helper `alexa/testing/signer.ts`): makes a throwaway root + leaf certificate (SAN `echo-api.amazon.com`) and returns `{ rootPem, chainPem, sign(body: Buffer): string }`.

- [ ] **Step 1: Write failing tests** with a test signer: accepts a correctly signed request; rejects (400, with reason): body changed after signing; missing headers; certificate URL with `http`, another host, host `s3.amazonaws.com.evil.com`, path not starting `/echo.api/`, or another port; expired certificate; certificate without the Alexa SAN; chain not leading to a trusted root; timestamp 151 s old or 151 s in the future; accepted at 149 s; body that is not JSON; body without `request.timestamp`. The certificate is fetched once per URL and cached (assert `fetchCert` call count).
- [ ] **Step 2: Run** `npx vitest run src/alexa/verify.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `verifyAlexaRequest` and `alexa/testing/signer.ts` — validate the URL with `new URL`; parse the PEM chain into `X509Certificate`s; check `validFrom/validTo`, `checkHost("echo-api.amazon.com")`, each certificate signed by the next (`verify(publicKey)`), the last signed by one of `roots`; verify with `createVerify("RSA-SHA256")` over `rawBody`; cache parsed chains in a Map keyed by URL (max 8 entries).
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(alexa): request signature and timestamp verifier`.

### Task 2: The speaking engine

**Files:**
- Create: `packages/server/src/alexa/engine.ts`, `packages/server/src/alexa/speech.ts`
- Test: `packages/server/src/alexa/engine.test.ts`

**Interfaces:**
- Consumes: `AlexaRequestBody` (Task 1).
- Produces:
  - `speech.ts`: `cleanSpeech(text: string, max = 8000): string` (strips markdown marks and `<>`, escapes `&`, collapses whitespace, truncates at a sentence end or `max`); `shortForVoice(text: string): { spoken: string; truncated: boolean }` (first ~3 sentences, at most 600 characters).
  - `interface AlexaReply { speech: string; reprompt?: string; end: boolean }`
  - `interface EngineDeps { ask(text: string, locale: string, deviceId: string): Promise<string>; fast: Partial<Record<FastIntent, (locale: string, slots: Record<string, string>) => Promise<string>>>; clock: () => number; budgetMs?: number /* default 6500 */; holdMs?: number /* default 600000 */; progressive?: (speech: string) => void }`
  - `type FastIntent = "PortfolioIntent" | "WeatherIntent" | "TasksIntent" | "StatusIntent"`
  - `class AlexaEngine { constructor(d: EngineDeps); handle(req: AlexaRequestBody, deviceKey: string): Promise<AlexaReply> }` — `LaunchRequest` greets and keeps the session open; `SessionEndedRequest`, `AMAZON.StopIntent`, `AMAZON.CancelIntent` end with empty speech; `AMAZON.HelpIntent` lists what to ask; lead-in intents `HowIntent` (lead-in "how"), `WhatIntent` ("what"), `TellMeIntent` ("tell me"), `ShowMeIntent` ("show me"), `RemindMeIntent` ("remind me"), `PleaseIntent` ("please") rebuild the sentence from lead-in plus slot `q` and call `ask`; `ReadyIntent` returns the held answer once; unknown intents get a short "I did not understand".

- [ ] **Step 1: Write failing tests:** fixed intent answered from `fast` without calling `ask`; `HowIntent` with `q = "my portfolio is doing"` calls `ask("how my portfolio is doing", …)`; hi-IN lead-ins use the Hindi words from a table; an answer later than the budget gives "Still working. Ask me if it is ready." and `ReadyIntent` then returns the answer once, and a second `ReadyIntent` says nothing is waiting; a second question while one is pending does not call `ask` again and says it is still working; a held answer expires after `holdMs`; reply with `&`, `<`, `*`, newlines, 20,000 characters, Devanagari and ₹ is cleaned and truncated; `SessionEndedRequest`/Stop end with `end: true` and empty speech; a thrown `ask` gives a short apology, not the error text.
- [ ] **Step 2: Run** `npx vitest run src/alexa/engine.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `cleanSpeech`, `shortForVoice` and `AlexaEngine`. The lead-in table has en and hi entries per intent. The budget is `Promise.race` between `ask` and a timer; the pending promise keeps running and stores its result in a per-`deviceKey` slot with a timestamp.
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(alexa): speaking engine with fast intents and slow-answer holder`.

### Task 3: Settings, config and devices

**Files:**
- Modify: `packages/server/src/config.ts`, `packages/server/src/settings.ts`
- Create: `packages/server/src/alexa/devices.ts`
- Test: `packages/server/src/alexa/settings.test.ts`, `packages/server/src/alexa/devices.test.ts`

**Interfaces:**
- Produces:
  - `AlexaConfig { installed: boolean; enabled: boolean; skillId: string; invocationName: string; allowedUsers: { id: string; name: string; addedAt: number }[] }` at `config.alexa` (defaults: not installed, empty skill id, empty invocation name, no users); `sanitizeAlexa(raw: unknown): AlexaConfig`; `DEFAULT_ALEXA`.
  - Settings patch `alexa: { skillId?: string /* amzn1.ask.skill.<uuid>, max 100 */; invocationName?: string /* validated: 2+ lower-case words, banned words refused */ }` (strict); `SettingsView.alexa = { installed, enabled, skillId, invocationName, allowed: { id: string; name: string }[] }` with ids shortened for display (`…last 6`); `refuseForAgent` refuses `alexa`.
  - `class AlexaDevices { constructor(config: () => AlexaConfig, save: () => void, clock: () => number); isAllowed(userId: string): boolean; noteWaiting(userId: string, deviceId: string, locale: string): void; waiting(): { id: string; short: string; deviceShort: string; locale: string; at: number }[]; allow(userId: string, name: string): boolean; forget(shortOrId: string): boolean }` — waiting list in memory, max 20, entries older than 24 h dropped, repeated notes for the same user update the time; at most 10 allowed users.

- [ ] **Step 1: Write failing tests:** defaults; `sanitizeAlexa` drops malformed users and caps at 10; the patch accepts a valid skill id and a valid name and refuses one-word names, names with `ask`/`alexa`/capitals/digits, and unknown fields; the view never lists a full user id; `refuseForAgent` refuses `alexa`; devices: allow moves a waiting user to allowed and saves; waiting stays at 20 (oldest dropped) and the same user is listed once; forget removes; the 11th allowed user is refused.
- [ ] **Step 2: Run** both tests — Expected: FAIL.
- [ ] **Step 3: Implement** the config and settings changes (same pattern as `brokers`) and `AlexaDevices`.
- [ ] **Step 4: Run** both tests plus `npx vitest run src/settings src/brokers/settings.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(alexa): config, settings and allowed devices`.

### Task 4: Voice-device trust and permission by message

**Files:**
- Modify: `packages/protocol/src/tiers.ts` (`Trust` adds `"voice-device"`), `packages/server/src/policy/engine.ts`
- Create: `packages/server/src/alexa/permission.ts`
- Test: `packages/server/src/alexa/permission.test.ts`, `packages/server/src/policy/voice.test.ts`

**Interfaces:**
- Produces:
  - `VOICE_TOOLS: ReadonlySet<string>` (weather.get, task.list, memory.search, system.info, portfolio.status, portfolio.summary, portfolio.holdings, portfolio.positions, portfolio.funds, portfolio.orders, reports.list, stage.scene, stage.show, stage.update, stage.hide, stage.mood, stage.presence); policy for `voice-device`: tool in `VOICE_TOOLS` → allow; else T3 → deny; else → ask.
  - `class VoicePermission { constructor(d: { send(channel: "telegram" | "whatsapp", to: "me", text: string): Promise<{ ok: boolean }>; channelsLinked(): ("telegram" | "whatsapp")[]; clock: () => number; waitMs?: number /* 300000 */ }); wrapEmit(base: (m: ServerMsg) => void, answer: (id: string, approve: boolean) => void): (m: ServerMsg) => void; tryReply(text: string): boolean }` — `wrapEmit` intercepts `approval.request`: with no linked channel or a PIN-needing request it answers deny at once; otherwise sends "Alexa asked to: <summary>. Reply YES within 5 minutes." and waits; `tryReply("yes"|"y"|"ha"|"haan"|"हाँ")` approves the newest pending one, `no`/`nahi` denies, anything else is not consumed (returns false); an unanswered request is denied after `waitMs`.

- [ ] **Step 1: Write failing tests:** policy table for `voice-device` (read tool allowed, `message.send` asks, `shell.run` and `reports.schedule` denied); `VoicePermission`: no channel linked → denied without sending; PIN request → denied without sending; YES approves, NO denies, unrelated text returns false and leaves it pending; timeout denies; the message text names the action and the 5-minute limit and carries no PIN.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the trust value, the policy branch and `VoicePermission`.
- [ ] **Step 4: Run** the new tests plus `npx vitest run src/policy src/agent` and the protocol tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(alexa): voice-device trust level and permission by message`.

### Task 5: Fast intents and the AlexaHub

**Files:**
- Create: `packages/server/src/alexa/hub.ts`
- Test: `packages/server/src/alexa/hub.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4; `BrokerHub` (`report`), `WeatherService` (`weatherSummary`), `Tasks`, `Agent.runTurn`, `ChannelHub.send`.
- Produces: `class AlexaHub { constructor(d: { config: Config; save(): void; verifyOptions(): Pick<VerifyOptions, "fetchCert" | "roots">; clock: () => number; agent: { isBusy(): boolean; runTurn(text: string, ctx: { trust: Trust; emit: (m: ServerMsg) => void; ip: string }): Promise<void> }; broadcast(m: ServerMsg): void; screenOpen(): boolean; fast: EngineDeps["fast"]; channels: Pick<ChannelHub, "send">; linked(): ("telegram" | "whatsapp")[]; audit: Audit; publicBase(): string | null }); handle(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ status: number; body: unknown }>; tryApprove(text: string): boolean; status(): AlexaStatus; devices: AlexaDevices; endpoint(): string | null }` where `AlexaStatus = { installed: boolean; enabled: boolean; skillIdSet: boolean; invocationName: string; endpoint: string | null; waiting: ...; allowed: ... }`.
- `handle` order: verify → 400 on failure; plugin off or `skillId` empty → 400; `applicationId` ≠ `config.alexa.skillId` → 400 (audit `alexa.refused`); user not allowed → record waiting, answer "I do not know this Echo yet. Allow it in Friend, under Plugins, Alexa." with `shouldEndSession: true`; allowed → engine. The agent runs with trust `voice-device`; its emit is wrapped by `VoicePermission.wrapEmit`, collects `caption.delta`, and broadcasts to the screen only when `screenOpen()`; answers longer than the short form are spoken short and sent in full to the screen (or to Telegram when the owner asked "send it"). Audit: `alexa.request` with intent name and device short id only.

- [ ] **Step 1: Write failing tests** (test signer from Task 1, fake agent): wrong signature 400; wrong application 400 and the agent is never called; unknown user gets the fixed speech, appears in `waiting()` once and the agent is not called; allowed user's question reaches the agent with trust `voice-device`; audit rows contain the intent but not the spoken text; busy agent gives a short "I am busy"; fast intent portfolio uses `fast` and not the agent; `tryApprove` forwards to the permission object.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `AlexaHub` and the `AlexaStatus` shape.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(alexa): hub that checks, routes and answers Alexa requests`.

### Task 6: Route and app wiring

**Files:**
- Modify: `packages/server/src/gateway.ts`, `packages/server/src/app.ts`, `packages/server/src/integrations.ts`, `packages/protocol/src/tools.ts` (integration id enums add `alexa`)
- Test: `packages/server/src/alexa/routes.test.ts`

**Interfaces:**
- Produces: `AlexaApi` dep in gateway `{ handle(raw: Buffer, headers): Promise<{ status: number; body: unknown }>; status(): unknown; allow(id: string, pin: string, ip: string): Promise<unknown>; forget(id: string): boolean; packageFile(name: string): { type: string; text: string } | null }`; routes: `POST /api/alexa` (no cookie, raw JSON body up to 32 KB, rate limit 60 per minute per address, always `application/json`), `GET /api/alexa` (owner session), `POST /api/alexa/devices/allow` body `{ id, pin }`, `DELETE /api/alexa/devices/:id`, `GET /api/alexa/package/:file` (owner session; files `skill.json`, `en-IN.json`, `hi-IN.json`). `IntegrationId` adds `"alexa"`; `integrationViews` returns a fourth view; `changeAny` handles `alexa` (install/remove/enable; remove forgets skill id and allowed users). Telegram/WhatsApp owner replies go through `alexaHub.tryApprove(text)` before the normal assistant call in the channel `ask` wrapper. `opts.alexaFetchCert` and `opts.alexaRoots` let tests inject the signer.

- [ ] **Step 1: Write failing tests** (full `createApp`, test signer): install with PIN, save skill id and invocation name, switch on; a signed request from an unknown user gets the fixed speech and shows under waiting in `GET /api/alexa`; allow with the wrong PIN is 403, with the right PIN 200 and the next request is answered by the assistant (fake provider); unsigned request 400; wrong application 400; oversize body 413; 61st request in a minute 429; `GET /api/alexa` without a cookie 401; the body never contains a full user id; `integrations.configure` by the assistant for alexa is refused; a Telegram "yes" reply while a permission is pending approves it and is not sent to the assistant.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** routes inside an encapsulated Fastify plugin that replaces the JSON parser with a buffer parser for `/api/alexa` only; wire `AlexaHub` in `app.ts` with the fast intents: portfolio via `brokerHub.report("zerodha","custom")`, weather via `WeatherService`, tasks via `Tasks.list`, status via the integration summary.
- [ ] **Step 4: Run** the new test, then the full server suite `npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(alexa): endpoint route and app wiring`.

### Task 7: Skill package generator

**Files:**
- Create: `packages/server/src/alexa/package.ts`
- Test: `packages/server/src/alexa/package.test.ts`

**Interfaces:**
- Produces: `buildSkillPackage(o: { invocationName: string; endpoint: string; publicBase: string | null }): Record<"skill.json" | "en-IN.json" | "hi-IN.json", string>` — `skill.json` is the manifest (`manifestVersion "1.0"`, `publishingInformation` for en-IN and hi-IN with name "Friend", `apis.custom.endpoint.uri = endpoint`, `sslCertificateType: "Wildcard"` or `"Trusted"` as the console expects for a public CA certificate), the two JSON files are interaction models (`languageModel.invocationName`, intents `PortfolioIntent`, `WeatherIntent` (optional `AMAZON.City` slot `city`), `TasksIntent`, `StatusIntent`, `ReadyIntent`, `HowIntent`, `WhatIntent`, `TellMeIntent`, `ShowMeIntent`, `RemindMeIntent`, `PleaseIntent` (each with one `AMAZON.SearchQuery` slot `q` and the lead-in in every sample), the built-in Help/Stop/Cancel/Fallback/NavigateHome intents, with Devanagari samples for hi-IN).

- [ ] **Step 1: Write failing tests:** the manifest is valid JSON with the endpoint; each model has the invocation name, every sample of a lead-in intent starts with its lead-in word and has exactly one `{q}`, no sample contains two slots, no intent name is duplicated, every `AMAZON.SearchQuery` slot appears at most once per sample, hi-IN samples contain Devanagari, and the invocation name passes the same validator as the setting.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `buildSkillPackage`; share the lead-in table with Task 2 (`alexa/phrases.ts`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(alexa): skill manifest and interaction models`.

### Task 8: Screens

**Files:**
- Create: `packages/web/src/plugins/AlexaForm.tsx`
- Modify: `packages/web/src/plugins/IntegrationConfig.tsx`, `packages/web/src/settings/settingsApi.ts`
- Test: `packages/web/src/plugins/alexa.test.tsx`

**Interfaces:**
- Produces: `AlexaApi { status(): Promise<AlexaStatus>; allow(id: string, pin: string): Promise<void>; forget(id: string): Promise<void> }`, `httpAlexaApi`; `AlexaForm({ view, setView, api })` — fields: skill id, invocation name; the endpoint to paste (copy button); three download links for the package files (`GET /api/alexa/package/<file>`); the steps list; devices: waiting rows with **Allow** (PIN) and allowed rows with **Forget**; a plain note about what Alexa may do and that PIN actions are refused on voice. Saving skill id / name goes through the page's PIN save as `{ alexa: { skillId?, invocationName? } }` (changed fields only).

- [ ] **Step 1: Write failing tests:** endpoint and files are shown; fields save only changed values after the PIN; waiting device shows a short id, Allow asks the PIN and calls `allow(id, "123456")`; Forget removes; the invalid invocation name is flagged before the PIN step; the Plugins list offers Alexa with Install.
- [ ] **Step 2: Run** `npx vitest run src/plugins/alexa.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** the components and wire `IntegrationConfig` for `id === "alexa"`.
- [ ] **Step 4: Run** the new test, the whole web suite and `npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Alexa Configure page and device list`.

### Task 9: Documentation, console walk-through, release

**Files:**
- Create: `docs/guides/alexa-setup.md`
- Modify: `README.md`, `packages/friend/package.json`

- [ ] **Step 1: Write the guide:** what Alexa can and cannot do (from the spec table); prerequisites (public HTTPS address, Amazon developer account); creating the skill in the Alexa developer console (custom, "Provision your own", language en-IN and hi-IN, paste the models, set the endpoint and the certificate option, copy the Skill ID into Friend, build, test in Development); allowing the Echo; the questions to try; making a Routine for scheduled spoken reports; troubleshooting (wrong skill id, Echo not allowed, endpoint unreachable, certificate not trusted, answer too slow).
- [ ] **Step 2: README section** "Alexa (plugin)".
- [ ] **Step 3: Console walk-through with Chrome control** on the owner's existing tab, with the owner entering their own Amazon login: create the skill, upload the two models and the manifest values, set the endpoint, copy the Skill ID, build the models, run a test utterance in the console's Test tab against the live Friend endpoint (needs the owner to save the skill id first); record what happened in the guide.
- [ ] **Step 4: Commit** `docs: Alexa setup guide and README section`.
- [ ] **Step 5: Full verification** (`tsc` and `vitest` in protocol, server, web, agent-cli) and **release**: bump, `npx vite build`, `node scripts/bundle.mjs`, package tests (publish only when no `FAIL`), `npm publish`, commit, push, `friend upgrade`, `friend version`.
