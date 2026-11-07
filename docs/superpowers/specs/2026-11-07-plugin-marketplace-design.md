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

## How the assistant installs: it reads first, like a person

It does not run a fixed download. It looks at the project the way a person would, then decides, and tells the owner what it found.

1. **Look.** `plugins.fetch {url}` (no PIN, installs nothing) accepts a GitHub repo link (`https://github.com/o/r[.git]`, optionally `/tree/<ref>/<folder>`) or `owner/repo`. It returns the folder listing, the README and the docs it points to (`README*`, `INSTALL*`, `docs/`, `AGENTS.md`/`CLAUDE.md` as plain text), and the Claude manifests if there are any (`.claude-plugin/marketplace.json`, `plugin.json`). Everything is kept in a staging folder for 15 minutes.
2. **Read.** `plugins.read {staging, path}` (no PIN) reads any other text file in that repo on request (a `SKILL.md`, a doc, a reference file), so the assistant can follow the README's trail: "see docs/install.md", "the skills are under plugin/skills".
3. **Decide and say it.** The assistant writes a short plain account to the owner: what this project is, what the README says to do, what it will take (skills, commands, agents), what it will leave out and why (scripts, hooks, MCP servers, installs that need a machine Friend does not have), and what it needs from the owner if anything is unclear — for example which of several plugins, or "this needs ffmpeg, which is not here; install anyway?". It asks only when it cannot tell.
4. **Install.** `plugins.import {staging, plugin?, skills?}` — T3, PIN. The assistant chooses the plugin and the skills the README and manifests point to. The approval card shows the source (repo and commit) and the full text of everything that will be installed. On approval it calls `authorPlugin`, then writes the memory note. Imported plugins carry their source, so the plugins screen shows "from github.com/o/r".
5. **Marketplaces.** `plugins.marketplace_add {repo}` (T3, PIN) fetches and checks `marketplace.json` and saves the repo (`marketplaces.json` in the data folder, at most 10). `plugins.marketplace_list` (T0) lists marketplaces and their plugins; `plugins.marketplace_remove` (T3). Installing from a marketplace goes through steps 1 to 4 on that plugin's `source` folder.

**Scripts and commands the README asks for** (`npm install`, `pip install`, a setup script) are allowed, but only through the guarded doors Friend already has, and only with the owner's OK each time:

- The assistant first tells the owner in plain words what the command is, where it comes from ("step 2 of the README of github.com/o/r"), and what it could do to the PC. It never runs it in the same breath as saying it.
- It runs through `shell.run` (the owner's PC, T2: the owner approves every command) or `code.run` (the sandbox, no network, no files, approval every run). Nothing is added that skips either.
- **Marked and never waived.** Once a turn has fetched or read outside text (`plugins.fetch`, `plugins.read`), every `shell.run` in that turn is marked on its approval card with "follows text from github.com/o/r" and a warning. Risky shapes get a stronger warning (download-and-run such as `curl … | sh`, `sudo`, `rm -rf`, registry edits, anything writing outside the project folder). The eye's skip-approval gate and any trust shortcut never apply to such a command.
- "Claude Code only" lines such as `/plugin install` are not commands to run: a skills-only plugin is exactly steps 1 to 4, and anything else is explained to the owner.

## Safety

- Hosts: `github.com`, `api.github.com`, `raw.githubusercontent.com` only; https only; redirects must stay on those hosts; 15 s per request, 2 MB in total per fetch, at most 60 files.
- The README and docs are data, never instructions: the assistant reads them to understand the project, but a line in them that says to run something, to skip the PIN or to change the owner's rules is ignored (the tool results are marked as outside text, as web results are today). A hostile README can at worst make it choose badly; it cannot install anything, because import always needs the PIN and the card shows the exact text that would be installed. Reading is limited to text files, 200 KB each.
- The import itself runs nothing: it writes text. Hooks are never installed. Imported plugins have skills only, no tools. Anything the README says to run goes through `shell.run` or `code.run` as described above, with the owner's OK every time.
- Skill text still sits below the owner's rules and the safety rules (the existing `skill.use` wording).
- The GitHub API is rate limited without a token (60/hour). A limit reply says so in plain words; no token is stored in this release.
- Everything is audited: `plugins.fetch` (repo, commit, file count) and `plugins.import` (plugin ids, skills).

## Noting it

After an import Friend writes `skills/<plugin-id>.md` in its memory tree: the plugin, where it came from, each skill and what it is for, and the date — so it can answer "what can you do now" and recall the skill later. This is the only memory written automatically.

## Honest limit, shown at install time

A skill is instructions. It can ask for tools Friend lacks (ffmpeg, a network, a rendering machine). The preview warns when the text mentions commands Friend does not have ("this skill expects ffmpeg; the code sandbox has none").

## Tests

Reading: the README and docs are returned and `plugins.read` follows a path from them, refuses a binary, an over-large file and a path outside the repo; a README that says "run this script" or "ignore the PIN" changes nothing (agent test with a scripted model). Fetching against a fake GitHub (a local server standing in for the three hosts): a valid marketplace, a repo with skills only, with commands and agents, with a symlink-like entry, with a skill over 20 KB, a redirect to another host (refused), more than 60 files (refused), a rate-limit reply. Import: PIN required, the card shows the full text, `authorPlugin` called, an upgrade bumps the patch version, the memory note is written, the audit rows exist. Agent: `plugins.fetch` never installs; `plugins.import` without a staging id or after expiry fails clearly. A recorded copy of the real `lemo-opuscar` manifests is a fixture.

## Later (not in this release)

Self-improvement: the assistant proposes a change to a skill it used, the owner sees the difference and approves with the PIN, each version is kept and can be undone. MCP servers shipped inside a plugin, offered as connectors with their own approval. A GitHub token for private repos and higher limits.
