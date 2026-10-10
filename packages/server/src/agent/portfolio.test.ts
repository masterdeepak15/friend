import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import type { ChannelHub } from "../channels/hub";
import { loadConfig, type Config } from "../config";
import { openDb } from "../db";
import { BrokerHub } from "../brokers/hub";
import { FakeKite } from "../brokers/testing/fakeKite";
import { inspectPlugin } from "../plugins";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import { Agent } from "./loop";

const call = (id: string, name: string, args: unknown = {}): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const one = (name: string, args: unknown = {}): ProviderEvent[][] => [[call("t1", name, args), done], [text("ok"), done]];

let emitted: ServerMsg[];
let approvals: Approvals;
let config: Config;
let send: ReturnType<typeof vi.fn<ChannelHub["send"]>>;
let kite: FakeKite;
let hub: BrokerHub;
let build: (provider: FakeProvider, withBrokers?: boolean) => Agent;

const emit = (m: ServerMsg) => {
  emitted.push(m);
  if (m.type === "approval.request") void approvals.respond({ id: m.id, decision: "approve", pin: m.needsPin ? "123456" : undefined }, "9.9.9.9");
};
const ctx = { trust: "owner" as const, emit, ip: "9.9.9.9" };
const lastTool = (p: FakeProvider) => JSON.stringify(p.calls.at(-1)!.messages.at(-1));
const ask = () => emitted.filter((m) => m.type === "approval.request") as Extract<ServerMsg, { type: "approval.request" }>[];
const login = async () => {
  const state = new URL(hub.loginLink("zerodha")!).searchParams.get("redirect_params")!.replace("state=", "");
  await hub.completeLogin({ request_token: kite.issueRequestToken(), state });
};

beforeEach(async () => {
  emitted = [];
  send = vi.fn<ChannelHub["send"]>(async (channel) => ({ ok: true, summary: `Sent by ${channel}.` }));
  kite = new FakeKite();
  const dir = mkdtempSync(join(tmpdir(), "friend-portfolio-"));
  const db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  config = loadConfig(dir);
  config.brokers.zerodha = { installed: true, enabled: true, apiKey: "KEY", apiSecret: "SECRET" };
  hub = new BrokerHub({ config, dataDir: dir, db, audit, channels: { send }, fetch: kite.fetch, publicBase: () => null });
  hub.apply();
  const policy = new PolicyEngine(db, config);
  approvals = new Approvals({ auth, policy, audit, db }, 500);
  build = (provider, withBrokers = true) =>
    new Agent({
      provider,
      policy,
      approvals,
      devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
      stage: new StageState(),
      db,
      audit,
      config,
      assistantName: () => "Jarvis",
      channels: { send, inbox: () => [] },
      ...(withBrokers ? { brokers: hub } : {}),
    });
});

describe("reading the portfolio", () => {
  it("manual: asks first (no PIN), then hands the model the worked-out figures", async () => {
    await login();
    const p = new FakeProvider(one("portfolio.summary"));
    await build(p).runTurn("how is my portfolio", ctx);
    expect(ask()).toHaveLength(1);
    expect(ask()[0]).toMatchObject({ tool: "portfolio.summary", tier: "T2", needsPin: false });
    expect(lastTool(p)).toContain("Portfolio: ₹");
  });

  it("auto: goes ahead without a card", async () => {
    await login();
    config.approvals = "auto";
    const p = new FakeProvider(one("portfolio.holdings"));
    await build(p).runTurn("what do I hold", ctx);
    expect(ask()).toEqual([]);
    expect(lastTool(p)).toContain("INFY");
    expect(lastTool(p)).not.toContain("ACCESS-1");
    expect(lastTool(p)).not.toContain("SECRET");
  });

  it("positions, funds and orders each answer from the account", async () => {
    await login();
    config.approvals = "auto";
    for (const [tool, word] of [["portfolio.positions", "RELIANCE"], ["portfolio.funds", "Available"], ["portfolio.orders", "2610100001"]] as const) {
      const p = new FakeProvider(one(tool));
      await build(p).runTurn("go", ctx);
      expect(lastTool(p)).toContain(word);
    }
  });

  it("status needs no approval and never shows figures", async () => {
    const p = new FakeProvider(one("portfolio.status"));
    await build(p).runTurn("is zerodha ready", ctx);
    expect(ask()).toEqual([]);
    expect(lastTool(p)).toMatch(/Login needed/);
    expect(lastTool(p)).not.toContain("₹");
  });

  it("tells the model to offer the login link when the login has ended", async () => {
    config.approvals = "auto";
    const p = new FakeProvider(one("portfolio.summary"));
    await build(p).runTurn("how is it", ctx);
    expect(lastTool(p)).toMatch(/login has ended/i);
    expect(lastTool(p)).toMatch(/reports\.run/);
  });

  it("says Zerodha is not set up when it is not", async () => {
    config.approvals = "auto";
    config.brokers.zerodha.enabled = false;
    hub.apply();
    const p = new FakeProvider(one("portfolio.summary"));
    await build(p).runTurn("how is it", ctx);
    expect(lastTool(p)).toMatch(/not set up/i);
    expect(ask()).toEqual([]);
  });

  it("is not available without the broker part", async () => {
    const p = new FakeProvider(one("portfolio.summary"));
    await build(p, false).runTurn("how is it", ctx);
    expect(lastTool(p)).toMatch(/not available/i);
  });

  it("refuses a token or secret as an argument, and refuses guests and household members", async () => {
    await login();
    config.approvals = "auto";
    const bad = new FakeProvider(one("portfolio.summary", { accessToken: "x", apiSecret: "y" }));
    await build(bad).runTurn("go", ctx);
    expect(lastTool(bad)).toMatch(/Invalid arguments/);
    for (const trust of ["guest", "member"] as const) {
      const p = new FakeProvider(one("portfolio.summary"));
      await build(p).runTurn("go", { ...ctx, trust });
      expect(lastTool(p)).toMatch(/not allowed/);
    }
  });
});

describe("reports", () => {
  it("run: returns the report text, or sends it when asked", async () => {
    await login();
    config.approvals = "auto";
    const p = new FakeProvider(one("reports.run", { kind: "morning" }));
    await build(p).runTurn("report", ctx);
    expect(lastTool(p)).toContain("Morning report - Zerodha");
    const q = new FakeProvider(one("reports.run", { send: true }));
    await build(q).runTurn("send me a report", ctx);
    expect(send).toHaveBeenCalledWith("telegram", "me", expect.stringContaining("Portfolio: ₹"));
  });

  it("run with send after the login ended sends the login link, not figures", async () => {
    config.approvals = "auto";
    const p = new FakeProvider(one("reports.run", { send: true }));
    await build(p).runTurn("send me a report", ctx);
    expect(send).toHaveBeenCalledTimes(1);
    const [, , body] = send.mock.calls[0]!;
    expect(body).toContain("https://kite.zerodha.com/connect/login");
    expect(body).not.toContain("₹");
    expect(lastTool(p)).toMatch(/login link/i);
    expect(lastTool(p)).not.toContain("kite.zerodha.com");
  });

  it("schedule: asks with the PIN even in auto, and the card says what is sent where", async () => {
    config.approvals = "auto";
    const p = new FakeProvider(one("reports.schedule", { name: "Morning", kind: "morning", time: "09:30", channel: "telegram" }));
    await build(p).runTurn("every morning at 9:30 on telegram", ctx);
    expect(ask()).toHaveLength(1);
    expect(ask()[0]).toMatchObject({ tool: "reports.schedule", tier: "T3", needsPin: true });
    expect(ask()[0]!.summary).toContain("09:30");
    expect(ask()[0]!.summary).toContain("sends your portfolio figures to Telegram");
    expect(hub.schedules.list()).toHaveLength(1);
    expect(hub.schedules.list()[0]).toMatchObject({ time: "09:30", channel: "telegram", days: [1, 2, 3, 4, 5] });
  });

  it("schedule: refuses a bad time without making one", async () => {
    config.approvals = "auto";
    const p = new FakeProvider(one("reports.schedule", { name: "Morning", kind: "morning", time: "25:00", channel: "telegram" }));
    await build(p).runTurn("go", ctx);
    expect(lastTool(p)).toMatch(/Invalid arguments/);
    expect(hub.schedules.list()).toHaveLength(0);
  });

  it("list needs no approval; remove asks with the PIN", async () => {
    const made = hub.schedules.add({ name: "Close", broker: "zerodha", kind: "close", time: "15:45", days: [1, 2, 3, 4, 5], channel: "whatsapp", commentary: false, enabled: true });
    const l = new FakeProvider(one("reports.list"));
    await build(l).runTurn("what reports", ctx);
    expect(ask()).toEqual([]);
    expect(lastTool(l)).toContain("15:45");
    expect(lastTool(l)).toContain(`#${made.id}`);
    const r = new FakeProvider(one("reports.remove", { id: made.id }));
    await build(r).runTurn("remove it", ctx);
    expect(ask()[0]).toMatchObject({ tool: "reports.remove", tier: "T3", needsPin: true });
    expect(hub.schedules.list()).toHaveLength(0);
  });
});

describe("the portfolio skill", () => {
  it("is a valid plugin with one skill that carries the rules", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const r = inspectPlugin(resolve(here, "../../../../plugins/portfolio-assistant"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.id).toBe("portfolio-assistant");
    expect(r.manifest.skills.map((s) => s.name)).toEqual(["portfolio"]);
    const body = r.skillText.get("portfolio") ?? "";
    expect(body).toMatch(/never tell the owner to buy or sell/i);
    expect(body).toMatch(/untrusted/i);
    expect(body).toMatch(/no orders/i);
  });
});
