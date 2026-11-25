import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpHub } from "../connectors/hub";
import { ConnectorStore } from "../connectors/store";
import { VaultOAuthProvider } from "./mcpProvider";
import { OAuthTickets } from "./tickets";
import { OAuthVault } from "./vault";

/** A tiny MCP server behind OAuth: it answers 401 until a request carries the token its own token endpoint handed out. */
function fakeService() {
  const seen: { path: string; auth: string | undefined; url: string }[] = [];
  let base = "";
  const bodyOf = (req: IncomingMessage) =>
    new Promise<string>((r) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => r(b));
    });
  const json = (res: ServerResponse, status: number, v: unknown, h: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...h });
    res.end(JSON.stringify(v));
  };
  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    seen.push({ path, auth: req.headers.authorization, url: req.url ?? "" });
    if (path.startsWith("/.well-known/oauth-protected-resource")) return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (path.startsWith("/.well-known/oauth-authorization-server"))
      return json(res, 200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (path === "/register") return json(res, 201, { client_id: "dyn-client", redirect_uris: JSON.parse(await bodyOf(req)).redirect_uris, token_endpoint_auth_method: "none" });
    if (path === "/token") {
      const p = new URLSearchParams(await bodyOf(req));
      if (p.get("grant_type") === "authorization_code" && p.get("code") === "GOOD" && p.get("code_verifier")) return json(res, 200, { access_token: "MCP-AT", token_type: "Bearer", expires_in: 3600, refresh_token: "MCP-RT" });
      return json(res, 400, { error: "invalid_grant" });
    }
    if (path === "/mcp") {
      if (req.headers.authorization !== "Bearer MCP-AT") return json(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
      const msg = JSON.parse((await bodyOf(req)) || "{}") as { id?: number; method?: string };
      if (msg.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      if (msg.method === "initialize") return json(res, 200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
      if (msg.method === "tools/list") return json(res, 200, { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "inbox", description: "Reads the inbox.", inputSchema: { type: "object", properties: {} } }] } });
      return json(res, 200, { jsonrpc: "2.0", id: msg.id, result: {} });
    }
    res.writeHead(404);
    res.end();
  });
  return {
    seen,
    start: () =>
      new Promise<string>((r) =>
        server.listen(0, "127.0.0.1", () => {
          base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          r(base);
        }),
      ),
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const live: { stop: () => Promise<void> }[] = [];
const hubs: McpHub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
  for (const s of live.splice(0)) await s.stop();
});

async function setup() {
  const svc = fakeService();
  live.push(svc);
  const base = await svc.start();
  const dir = mkdtempSync(join(tmpdir(), "friend-mcp-oauth-"));
  const vault = new OAuthVault(dir);
  const tickets = new OAuthTickets();
  const hub = new McpHub(new ConnectorStore(dir), {
    oauth: { provider: (id, name, _url, onConsent) => new VaultOAuthProvider(`mcp:${id}`, vault, tickets, "https://maya.example.com/api/oauth/callback", `Friend (${name})`, onConsent, true) },
  });
  hubs.push(hub);
  return { svc, base, dir, vault, tickets, hub };
}

describe("an MCP connector that signs in with a link", () => {
  it("waits for approval instead of failing, then connects after the owner approves, with the token only in the header", async () => {
    const { svc, base, vault, hub, dir } = await setup();
    const view = await hub.add({ id: "gmail", name: "Gmail", kind: "http", url: `${base}/mcp`, auth: "oauth" });
    expect(view).toMatchObject({ id: "gmail", status: "needs-approval", error: "Waiting for your approval.", oauth: true, tools: 0 });

    const consent = hub.takeConsent("gmail")!;
    expect(consent.origin + consent.pathname).toBe(`${base}/authorize`);
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(consent.searchParams.get("redirect_uri")).toBe("https://maya.example.com/api/oauth/callback");
    expect(consent.searchParams.get("resource")).toBe(`${base}/mcp`);
    expect(consent.searchParams.get("client_id")).toBe("dyn-client");
    expect(hub.takeConsent("gmail")).toBeNull();

    const done = await hub.finishOAuth("gmail", "GOOD");
    expect(done).toMatchObject({ status: "ready", tools: 1 });
    expect(hub.toolSpecs().map((t) => t.name)).toContain("mcp.gmail.inbox");

    const withToken = svc.seen.filter((s) => s.auth === "Bearer MCP-AT");
    expect(withToken.length).toBeGreaterThan(0);
    expect(svc.seen.every((s) => !s.url.includes("MCP-AT"))).toBe(true);
    const raw = readFileSync(join(dir, "oauth-vault.json"), "utf8");
    expect(raw).not.toContain("MCP-AT");
    expect(raw).not.toContain("MCP-RT");
    expect(vault.get("mcp:gmail").tokens).toMatchObject({ access_token: "MCP-AT" });
  });

  it("a wrong code does not connect it", async () => {
    const { base, hub } = await setup();
    await hub.add({ id: "gmail", name: "Gmail", kind: "http", url: `${base}/mcp`, auth: "oauth" });
    await expect(hub.finishOAuth("gmail", "BAD")).rejects.toThrow();
    expect(hub.list()[0]!.status).toBe("needs-approval");
  });

  it("a connector with a pasted key behaves as before", async () => {
    const { base, hub } = await setup();
    const v = await hub.add({ id: "plain", name: "Plain", kind: "http", url: `${base}/mcp`, headers: { Authorization: "Bearer MCP-AT" } });
    expect(v).toMatchObject({ status: "ready", oauth: false });
  });

  it("refuses to send the owner to a private address the service names", async () => {
    const { vault, tickets } = await setup();
    const p = new VaultOAuthProvider("mcp:x", vault, tickets, "https://h/cb", "Friend", () => {}, false);
    expect(() => p.redirectToAuthorization(new URL("https://169.254.169.254/authorize"))).toThrow();
    expect(() => p.redirectToAuthorization(new URL("https://login.example.com/authorize"))).not.toThrow();
  });

  it("will not use a login with a different authorization server", async () => {
    const { vault, tickets } = await setup();
    const p = new VaultOAuthProvider("mcp:x", vault, tickets, "https://h/cb", "Friend", () => {});
    p.saveClientInformation({ client_id: "a", issuer: "https://as1.example.com" } as never);
    p.saveTokens({ access_token: "T", token_type: "Bearer", issuer: "https://as1.example.com" } as never);
    p.saveClientInformation({ client_id: "b", issuer: "https://as2.example.com" } as never);
    expect(p.tokens()).toBeUndefined();
  });
});
