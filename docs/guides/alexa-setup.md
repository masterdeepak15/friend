# Alexa: talk to Friend from an Echo

You can talk to Friend through your own Echo devices: "Alexa, ask jarvis assistant how my portfolio is". Friend answers aloud, and also on the Friend screen if one is open. It is **free**: you make a small private skill in your own Amazon developer account and leave it in *development* mode (it is never published), and Friend itself is the skill's server. No AWS account, no Lambda, no paid plan.

## What Alexa can and cannot do

| Can | Cannot |
|---|---|
| Answer fixed questions straight from Friend: portfolio, weather, tasks, status | Speak on its own. Amazon only lets a skill answer when you speak to it (see "Scheduled spoken reports" below for the way round) |
| Pass open questions to the assistant: start the sentence with one of about 30 words ("how", "what", "tell me", "show me", "remind me", "can you", "find", "check", "add", "send", "explain", "summarize", "calculate", "translate", "list", "when", "where", "who", "why"...) and then say anything | Understand Marathi (Alexa custom skills support English India and Hindi India) |
| Add a reminder to your task list | Change settings, run commands, read or write files, use the camera, or do anything that needs your PIN |
| Show the whole conversation on the Friend screen when one is open | Answer in more than about 8 seconds: a slow answer is held, and Alexa says "Still working. Ask me if it is ready." |

**Permission.** An action that would normally ask you (for example sending a message) is sent to your Telegram or WhatsApp: "Alexa asked to ... Reply YES to allow it, or NO, within 2 minutes." With no linked messaging app and no screen open, such actions are skipped. Anything that needs your PIN is refused by voice.

**Who can use it.** Only Echo devices you allow. Anyone standing next to an allowed Echo can speak to it (Alexa does not identify voices for a private skill), which is why the voice can only read, and why risky actions are refused.

## What you need

- An Amazon account and a free **Amazon developer** account (<https://developer.amazon.com/alexa/console/ask>), the same Amazon account your Echo is signed in to.
- Friend reachable from the internet at a public **HTTPS** address with a real certificate on port 443 (for example `https://friend.example.com`). A self-signed certificate does not work for Amazon. Set it with `friend config set publicUrl https://friend.example.com`.
- Friend 0.1.24 or newer.

If your address is temporary, nothing else is tied to it: when it changes, set the new `publicUrl` and paste the new endpoint in the console again (step 4). The skill id, your allowed Echo devices and the models stay as they are.

## 1. Install the plugin

Esc, then **Plugins**. Under *Available*, press **Install** next to **Alexa** (PIN), then **Configure**.

## 2. Create the skill in the Alexa developer console

1. In the console press **Create Skill**.
2. Skill name: `Friend Assistant` (any name; it is not what you say). Primary locale: **English (IN)**.
3. Experience: **Other**. Model: **Custom**. Hosting: **Provision your own**. Template: **Start from Scratch**. Press **Create Skill**.
4. In the new skill's address bar, copy the **Skill ID** (`amzn1.ask.skill....`). It is not a secret.

## 3. Tell Friend the skill id and the name

On Friend's Alexa Configure page enter the **Skill ID** and an **Invocation name**, then **Save…** (PIN). The invocation name is what you say after "Alexa, ask". Use lower-case letters only, with none of: alexa, amazon, echo, skill, app, ask, tell, open, start, run, enable. Amazon asks for **two or more words** for a skill that is published; a skill kept in development mode on your own account also accepts a single word such as `maya` ("Alexa, ask maya how my portfolio is"). If the console ever refuses a single word, use two (for example `maya assistant`). Friend checks the rest for you.

Then switch the plugin on in the plugins list (**Turn on**, PIN).

## 4. Give Amazon the endpoint and the models

On the Configure page:

- **Endpoint**: copy the address shown (it ends in `/api/alexa`).
- Download **skill.json**, **en-IN.json** and **hi-IN.json** (they appear once the invocation name is saved).

In the console:

1. **Build → Endpoint**: choose **HTTPS**, paste the endpoint as the *Default Region* address, and choose **"My development endpoint has a certificate from a trusted certificate authority"**. Save.
2. **Build → Interaction Model → JSON Editor**: paste the contents of `en-IN.json` and **Save**.
3. **Languages**: add **Hindi (IN)** (Language Settings), open its JSON Editor, paste `hi-IN.json`, and save.
4. Press **Build skill** (the models for both languages).

## 5. Allow your Echo

Say "Alexa, ask *your invocation name*" to your Echo. Alexa says it does not know this Echo yet. On Friend's Configure page the Echo appears under **Echo devices**: press **Allow** (PIN). Now try:

- "Alexa, ask jarvis assistant how my portfolio is"
- "Alexa, ask jarvis assistant what are my tasks"
- "Alexa, ask jarvis assistant weather in Pune"
- "Alexa, ask jarvis assistant tell me a joke"
- "Alexa, ask jarvis assistant explain how compound interest works"
- "Alexa, ask jarvis assistant remind me to call mom at six"
- "Alexa, ask jarvis assistant is it ready" (after a slow answer)

Your skill is in *development* mode, so it works on every Echo signed in to the same Amazon account, with no review or publishing.

## Scheduled spoken reports (Routines)

Amazon does not let Friend start talking, but an Alexa **Routine** can. In the Alexa app: More → Routines → **+**, *When*: Schedule (for example 9:30 on weekdays), *Action*: Alexa says / Customized → "ask jarvis assistant how my portfolio is" (check on your device that routines can start your skill). The Echo then speaks Friend's answer at that time.

## Privacy

- The only thing Friend keeps about Alexa is the allowed Amazon account ids (shown shortened) and a short log line per request (the kind of question and the last four characters of the device id, never what was said).
- Open questions go to the AI model you chose in Settings; fixed questions (portfolio, weather, tasks, status) use no model.
- Amazon sees what you say to Alexa, as with any Alexa skill.

## Troubleshooting

| You see | Why | What to do |
|---|---|---|
| Alexa: "There was a problem with the requested skill's response" | Friend did not answer, or refused the request | Check the endpoint address matches, the skill id in Friend is exactly the console's, and the plugin is on |
| Console says the endpoint's certificate is not trusted | A self-signed or expired certificate | Use a real certificate on your public address |
| "I do not know this Echo yet" | The Echo is not allowed | Configure → Echo devices → **Allow** |
| "Still working. Ask me if it is ready." | The answer took longer than Alexa's time limit | Ask "is it ready" |
| The skill does not open by name | The invocation name is not built yet or is not distinctive | Rebuild the model; try a two-word name |
| The Echo cannot find the skill | Different Amazon account | Use the Amazon account the developer console is signed in to |

## For developers

Friend's endpoint verifies every request (certificate address, certificate chain, signature over the raw body, 150-second timestamp) before reading it, and checks the application id and the Amazon user id. The verifier (`packages/server/src/alexa/verify.ts`) does not depend on the rest of Friend.
