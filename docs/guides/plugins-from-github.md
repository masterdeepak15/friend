# Skills from GitHub

You can ask Friend to install skills from a GitHub repository, the way you would in Claude Code.

## What to say

- "Install https://github.com/lemomo-ai/lemo-opuscar.git"
- "Add the marketplace owner/repo", "what is in it", "install `name` from it"
- "What skills do you have now?"

## What happens

1. **Friend looks.** It fetches the list of files, the README and the docs, and any Claude Code manifests (`.claude-plugin/marketplace.json`, `plugin.json`). Nothing is installed and no PIN is needed for this. If you did not name the repository yourself, Friend asks first.
2. **Friend reads.** It follows what the README points to (`docs/install.md`, a `SKILL.md`) and then tells you, in plain words, what the project is, what the README says to do, what it will take, what it will leave out and why. It asks only if it cannot tell: which of several plugins, or "this needs ffmpeg and Friend has none".
3. **You approve.** The card shows the source (repository and commit) and the full text of every skill. You enter your PIN. Then the skills are switched on, a note goes into Friend's memory (`skills/<plugin>.md`), and the Plugins screen shows "from github.com/…".

## What is imported

| In the repository | In Friend |
|---|---|
| `skills/<name>/SKILL.md` | a skill, as written |
| `commands/<name>.md` | a skill named `cmd-<name>` |
| `agents/<name>.md` | a skill named `agent-<name>` |
| hooks, `.mcp.json`, scripts | not imported; the preview lists them with the reason |

A skill is instructions. If it needs tools Friend does not have (ffmpeg, a network, a rendering machine) the preview says so, and the skill may install but not fully run. A skill larger than 20 KB is left out, and at most 10 skills are taken from one plugin.

## What if the README asks for a command

For example `npm install` or `sh scripts/setup.sh`. Friend does not run anything by itself. It tells you what the command is, where it comes from and what it could do, and only then asks to run it through the normal command approval (`shell.run` on your PC) or the code sandbox. The card says "follows text from github.com/…", lists warnings for risky shapes (download and run, `sudo`, deleting folders, the registry, system folders) and has no "Always allow" button. A command that follows repository text is asked about every time, even a harmless-looking one.

## Limits

Only github.com, api.github.com and raw.githubusercontent.com, over https. At most 60 files and 2 MB read at a time, 200 KB per file, text only. A look is forgotten after 15 minutes. GitHub allows 60 reads an hour without an account; if that runs out Friend says when to try again. At most 10 marketplaces are kept.
