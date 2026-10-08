#!/usr/bin/env node
/**
 * A stand-in for chrome-control-mcp over stdin/stdout, for tests of the one-click connector. Its `status` tool answers like the
 * real one: {"connected": true, "extension": true}. Arguments: --ext-off (the Chrome extension is not linked),
 * --status-error (the status tool fails), --status-text (it answers in words instead of JSON).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const args = process.argv.slice(2);
const obj = { type: "object", properties: {} };
const server = new Server({ name: "fake-chrome", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "status", description: "Is the extension connected?", inputSchema: obj },
    { name: "list_pages", description: "Lists open pages.", inputSchema: obj },
    { name: "take_snapshot", description: "Reads the page.", inputSchema: obj },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });
  if (req.params.name === "status") {
    if (args.includes("--status-error")) return text("status is broken", true);
    if (args.includes("--status-text")) return text("the extension is not connected yet");
    return text(JSON.stringify({ connected: true, mode: "peer", extension: !args.includes("--ext-off"), port: 8765, selectedPage: null }, null, 2));
  }
  return text(`called ${req.params.name}`);
});
await server.connect(new StdioServerTransport());
