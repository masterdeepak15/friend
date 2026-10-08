import { join } from "node:path";
import { authorPlugin, type PluginSpec } from "./author";
import type { McpHub } from "./connectors/hub";
import type { Plugins } from "./plugins";
import { isPluginId } from "./plugins";

/** Managing connectors and plugins on the AI's behalf. Each call has already been approved by the owner (with the PIN where it needs one). */
export interface AdminApi {
  /** Runs one of the connectors.* or plugins.* tools and returns what to tell the model. Throws an Error to refuse. */
  run(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface AdminDeps {
  hub: McpHub;
  plugins: Plugins;
  dataDir: string;
  /** Called for every change, with the tool name and the id it was about (never any content). */
  audit: (what: string, detail: Record<string, unknown>) => void;
}

const id = (args: Record<string, unknown>): string => String(args.id ?? "");

export function makeAdmin(d: AdminDeps): AdminApi {
  const connectorLine = (v: Awaited<ReturnType<McpHub["reload"]>>): string =>
    v.status === "ready" ? `${v.name} (${v.id}) is on with ${v.tools} tools. Its tools are named mcp.${v.id}.<tool>.` : v.status === "error" ? `${v.name} (${v.id}) is saved but not working: ${v.error ?? "unknown error"}` : `${v.name} (${v.id}) is ${v.status}.`;

  return {
    async run(name, args) {
      switch (name) {
        case "connectors.list": {
          const list = d.hub.list();
          return list.length ? list.map((c) => `${c.id}: ${c.name}, ${c.kind}, ${c.status}${c.error ? ` (${c.error})` : ""}${c.status === "ready" ? `, ${c.tools} tools` : ""}`).join("\n") : "No connectors yet.";
        }
        case "connectors.add": {
          const base = { id: args.id, name: args.name, kind: args.kind };
          const cfg = args.kind === "http" ? { ...base, url: args.url, headers: {} } : { ...base, command: args.command, args: args.args ?? [], env: {} };
          const v = await d.hub.add(cfg);
          d.audit("connectors.add", { id: v.id, kind: v.kind, status: v.status });
          return connectorLine(v);
        }
        case "connectors.enable": {
          const v = await d.hub.setEnabled(id(args), true);
          d.audit("connectors.enable", { id: v.id, status: v.status });
          return connectorLine(v);
        }
        case "connectors.disable": {
          const v = await d.hub.setEnabled(id(args), false);
          d.audit("connectors.disable", { id: v.id });
          return `${v.name} (${v.id}) is off. Its tools are gone from your list.`;
        }
        case "connectors.reload": {
          const v = await d.hub.reload(id(args));
          d.audit("connectors.reload", { id: v.id, status: v.status });
          return connectorLine(v);
        }
        case "connectors.remove":
          await d.hub.remove(id(args));
          d.audit("connectors.remove", { id: id(args) });
          return `Removed the connector ${id(args)}.`;

        case "plugins.list": {
          const list = d.plugins.list();
          return list.length ? list.map((p) => `${p.id}: ${p.name} ${p.version}, ${p.enabled ? "on" : "off"}${p.error ? ` (cannot be used: ${p.error})` : ""}, ${p.skills.length} skills [${p.skills.map((s) => s.name).join(", ")}], ${p.tools.length} tools [${p.tools.map((t) => t.name).join(", ")}]`).join("\n") : "No plugins installed.";
        }
        case "plugins.create": {
          const r = authorPlugin(d.plugins, join(d.dataDir, "drafts"), args as unknown as PluginSpec);
          if (!r.ok) throw new Error(`The plugin was not created: ${r.error}`);
          d.audit("plugins.create", { id: r.id, upgraded: r.upgraded, skills: r.skills, tools: r.tools });
          return `${r.upgraded ? "Updated" : "Created"} the plugin ${r.id} and switched it on: ${r.skills} skills, ${r.tools} tools. ${r.skills ? "Load a skill with skill.use. " : ""}${r.tools ? `Its tools are plugin.${r.id}.<tool> (each call asks the owner).` : ""}`.trim();
        }
        case "plugins.reload": {
          d.plugins.reload();
          d.audit("plugins.reload", {});
          const list = d.plugins.list();
          const bad = list.filter((p) => p.error);
          return `Read ${list.length} plugins again.${bad.length ? ` Not usable: ${bad.map((p) => `${p.id} (${p.error})`).join("; ")}.` : ""}`;
        }
        case "plugins.enable":
        case "plugins.disable": {
          const pid = id(args);
          if (!isPluginId(pid) || !d.plugins.setEnabled(pid, name === "plugins.enable")) throw new Error(`There is no plugin "${pid}".`);
          d.audit(name, { id: pid });
          return `The plugin ${pid} is ${name === "plugins.enable" ? "on" : "off"}.`;
        }
        case "plugins.remove": {
          const pid = id(args);
          if (!isPluginId(pid) || !d.plugins.remove(pid)) throw new Error(`There is no plugin "${pid}".`);
          d.audit("plugins.remove", { id: pid });
          return `Deleted the plugin ${pid}.`;
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    },
  };
}
