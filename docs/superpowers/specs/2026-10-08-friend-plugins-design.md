# Friend Plugin Store Design Spec and Plan

Date: 2026-10-08 · Status: approved by delegation ("do as you doing")

## 1. Purpose
Anyone can extend Friend without touching its code, and the owner can add, switch off and remove extensions with one command or one panel. Because a plugin is someone else's work, it can never be more powerful than the sandbox that runs it.

## 2. What a plugin is
A folder with `plugin.json` (and the files it names):
```json
{ "id": "unit-converter", "name": "Unit converter", "version": "1.0.0", "description": "...",
  "skills": [{ "name": "standup", "description": "Write a stand-up update", "file": "skills/standup.md" }],
  "tools":  [{ "name": "convert", "description": "Convert a value between units", "language": "python",
               "file": "tools/convert.py",
               "input": { "value": { "type": "number" }, "from": { "type": "string" }, "to": { "type": "string" } },
               "required": ["value", "from", "to"] }] }
```
- `id` and every skill/tool `name`: lowercase letters, digits and single hyphens (1 to 40 characters), so names can never collide with the `.`-to-`__` tool-name encoding.
- **Skills** are instructions (Markdown, up to 20 KB). The agent sees each skill's name and description in its prompt and loads the full text with the tool `skill.use {plugin, name}` (T0) when it fits the request. A skill gives the model words, never power: every action it leads to still goes through the normal tools and approvals.
- **Tools** are programs (python, node or shell, up to 50 KB) run by the Docker code sandbox (no network, no access to the owner's files, read-only root, time and memory limits). The arguments arrive as JSON in `/work/args.json`; whatever the program prints is the result. The model sees the tool as `plugin.<id>.<name>` with the declared input (properties of type string, number, integer or boolean; unknown properties are refused). Every call is tier T2: the approval card shows the plugin, the tool and the arguments.
- Limits: at most 10 skills and 10 tools per plugin, at most 50 files and 1 MB per plugin, no symlinks, every `file` must stay inside the plugin folder.

## 3. The store
- `friend plugin catalog` lists the bundled catalog (`plugins/` in the repo: `unit-converter`, `standup-writer`, `rubber-duck`). `friend plugin install <catalog-id | folder>` validates and shows what the plugin contains ("2 tools run in a sandbox with no network or file access, 1 skill"), asks the owner to confirm, copies it to `<dataDir>/plugins/<id>/` and records it. Installing an existing id upgrades it and keeps its on/off state. `list`, `enable`, `disable`, `remove` do what they say.
- Installed plugins are re-validated every time they load. A broken or tampered plugin is switched off with a visible reason; it never stops Friend from starting.
- The owner menu gets a **Plugins** panel (list, on/off, remove; install from the catalog needs the PIN).
- Out for now: downloading plugins from the internet (a remote index needs signing to be safe), plugins with network access or file access, plugin-provided UI.

## 4. Safety notes
- Plugin text (descriptions, skills, tool output) is untrusted: the prompt labels skills as plugin instructions that cannot override the owner's rules, and tool output is data like any tool result.
- Plugin tools reuse the T2 approval, so nothing runs unseen; "Always allow" is limited to identical arguments, as for shell commands.
- A plugin cannot add a tier-0/1 tool: all its tools are T2, all its skills are text.

## 5. Plan
1. Manifest schema, `Plugins` store (install, validate, list, enable, disable, remove, load), migration 5. Tests first.
2. Agent integration: dynamic tool definitions, `skill.use`, skills in the prompt, args file in the code box. Tests first.
3. CLI commands and the bundled catalog (3 plugins, validated and run in tests, the converter in real Docker).
4. Web Plugins panel (server routes with PIN for install), docs, merge to `main`.
