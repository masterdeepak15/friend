# Plugin marketplaces and install from a link — design

Date: 2026-11-07. Status: for review. First release only (self-improvement and MCP servers inside plugins come later).

## What the owner can say

- "Install https://github.com/lemomo-ai/lemo-opuscar.git" — Friend fetches it, shows what is in it, and after the PIN the skills are on.
- "Add the marketplace owner/repo", "what is in it", "install `name` from it" — the same as Claude Code's marketplaces.
- Afterwards Friend says which skills it has and what each is for, and remembers it.

## Why this fits what exists

Friend already has plugins (`plugins.ts`: a `plugin.json` with skills and sandboxed tools, checked for names, sizes and paths) and `authorPlugin`, which writes a plugin from a spec, installs it, switches it on and reloads. The importer builds a `PluginSpec` from the fetched files and hands it to `authorPlugin`. Nothing new is trusted: the existing checks (20 KB per skill, 10 skills, 50 files, 1 MB, no links, valid names) stay in force and a skill still never overrides the owner's rules.

Claude Code's layout, as seen in `lemomo-ai/lemo-opuscar`: `.claude-plugin/marketplace.json` lists plugins (`name`, `source` folder, `description`); each plugin has `.claude-plugin/plugin.json` and `skills/<name>/SKILL.md` (frontmatter `name`, `description`, then the instructions). Plugins may also carry `commands/*.md`, `agents/*.md`, `hooks` and `.mcp.json`.

## Compatibility (first release)

| Claude Code | In Friend |
|---|---|
| `skills/<n>/SKILL.md` | Imported as a skill (name, description from the frontmatter) |
| `commands/<n>.md` | Imported as a skill named `cmd-<n>` |
| `agents/<n>.md` | Imported as a skill named `agent-<n>` |
| `hooks`, `.mcp.json`, scripts | Not imported. The preview lists them as "left out" with the reason |
| `marketplace.json` | Read to list and find plugins |

A skill that names files it needs (`references/…`) is imported with its text only; the preview says "this skill refers to N files that were not imported". A skill over 20 KB is refused with that reason (a ruling to revisit if real skills are often larger).

## Steps and tools

1. `plugins.fetch {url}` — **no PIN, installs nothing.** Accepts a GitHub repo link (`https://github.com/o/r[.git]`, optionally `/tree/<ref>/<folder>`) or `owner/repo`. It downloads only text files it needs (the two manifests, `SKILL.md`, `commands/*.md`, `agents/*.md`) through the GitHub API and `raw.githubusercontent.com` — nothing else, no archives of the whole repo — and keeps them in a staging folder (`drafts/`, expires after 15 minutes). Returns a staging id and a preview: plugin names, each skill's name and description, what was left out, the source commit, and warnings.
2. `plugins.import {staging, plugin?}` — **T3, PIN.** The approval card shows the source (repo and commit) and the full text of every skill. On approval it calls `authorPlugin` (one Friend plugin per Claude plugin, id from its name; a plugin already installed is upgraded to the next patch version) and writes the memory note. Plugins imported this way are marked with their source so the plugins screen shows "from github.com/o/r".
3. `plugins.marketplace_add {repo}` (T3, PIN) — fetches and checks `marketplace.json`, saves the repo in the list of marketplaces (`marketplaces.json` in the data folder, at most 10). `plugins.marketplace_list` (T0) — marketplaces and the plugins in them (name, description). `plugins.marketplace_remove` (T3). Installing from a marketplace is `plugins.fetch` on that plugin's `source` folder, then the same `plugins.import`.

## Safety

- Hosts: `github.com`, `api.github.com`, `raw.githubusercontent.com` only; https only; redirects must stay on those hosts; 15 s per request, 2 MB in total per fetch, at most 60 files.
- The fetched text is data. It reaches the model only after the owner has approved the import; the preview the model sees before that is limited to names, descriptions and counts (so a hostile description cannot steer it more than a plugin catalog entry can today, and descriptions are length-capped at 300).
- Nothing the repo contains is run, ever: no scripts, hooks or install steps. Imported plugins have skills only, no tools.
- Skill text still sits below the owner's rules and the safety rules (the existing `skill.use` wording).
- The GitHub API is rate limited without a token (60/hour). A limit reply says so in plain words; no token is stored in this release.
- Everything is audited: `plugins.fetch` (repo, commit, file count) and `plugins.import` (plugin ids, skills).

## Noting it

After an import Friend writes `skills/<plugin-id>.md` in its memory tree: the plugin, where it came from, each skill and what it is for, and the date — so it can answer "what can you do now" and recall the skill later. This is the only memory written automatically.

## Honest limit, shown at install time

A skill is instructions. It can ask for tools Friend lacks (ffmpeg, a network, a rendering machine). The preview warns when the text mentions commands Friend does not have ("this skill expects ffmpeg; the code sandbox has none").

## Tests

Fetching against a fake GitHub (a local server standing in for the three hosts): a valid marketplace, a repo with skills only, with commands and agents, with a symlink-like entry, with a skill over 20 KB, a redirect to another host (refused), more than 60 files (refused), a rate-limit reply. Import: PIN required, the card shows the full text, `authorPlugin` called, an upgrade bumps the patch version, the memory note is written, the audit rows exist. Agent: `plugins.fetch` never installs; `plugins.import` without a staging id or after expiry fails clearly. A recorded copy of the real `lemo-opuscar` manifests is a fixture.

## Later (not in this release)

Self-improvement: the assistant proposes a change to a skill it used, the owner sees the difference and approves with the PIN, each version is kept and can be undone. MCP servers shipped inside a plugin, offered as connectors with their own approval. A GitHub token for private repos and higher limits.
