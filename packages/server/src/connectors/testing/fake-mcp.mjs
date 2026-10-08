#!/usr/bin/env node
/**
 * A small MCP server over stdin/stdout for tests of the connector hub. Tools:
 *   echo {text}      returns the text
 *   boom             returns an error result
 *   slow {ms}        answers after a delay
 *   picture          returns an image part
 *   secret           returns the value of FAKE_SECRET from its environment
 *   die              exits the program at once
 *   do__thing        a name with a double underscore (the hub must tame it)
 *   a-very-long-tool-name-that-goes-on-and-on   a name that is too long for the model
 * Environment: FAKE_MCP_EXTRA=1 adds a tool called "extra"; FAKE_MCP_SILENT=1 never answers (a program that hangs).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.FAKE_MCP_SILENT === "1") {
  setInterval(() => {}, 1000);
} else {
  const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
  const tools = () => [
    { name: "echo", description: "Returns the text.", inputSchema: obj({ text: { type: "string" } }, ["text"]) },
    { name: "boom", description: "Always fails.", inputSchema: obj() },
    { name: "slow", description: "Answers after a delay.", inputSchema: obj({ ms: { type: "number" } }) },
    { name: "picture", description: "Returns a picture.", inputSchema: obj() },
    { name: "secret", description: "Returns FAKE_SECRET.", inputSchema: obj() },
    { name: "die", description: "Exits.", inputSchema: obj() },
    { name: "do__thing", description: "A name with a double underscore.", inputSchema: obj() },
    { name: "a-very-long-tool-name-that-goes-on-and-on", description: "A very long name.", inputSchema: obj() },
    ...(process.env.FAKE_MCP_EXTRA === "1" ? [{ name: "extra", description: "Only when asked for.", inputSchema: obj() }] : []),
  ];

  const server = new Server({ name: "fake-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });
    switch (name) {
      case "echo":
        return text(`echo: ${args.text}`);
      case "boom":
        return text("it broke", true);
      case "slow":
        await new Promise((r) => setTimeout(r, Number(args.ms ?? 100)));
        return text("done waiting");
      case "picture":
        return { content: [{ type: "image", data: "QUJD", mimeType: "image/png" }] };
      case "secret":
        return text(`secret=${process.env.FAKE_SECRET ?? "(none)"}`);
      case "die":
        process.exit(3);
        return text("unreachable");
      default:
        return text(`called ${name}`);
    }
  });
  await server.connect(new StdioServerTransport());
}
