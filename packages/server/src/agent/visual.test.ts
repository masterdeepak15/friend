import { TOOL_DEFS, type ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import type { Weather, WeatherService } from "../weather";
import { Agent } from "./loop";
import { promptParts } from "./prompt";

const call = (id: string, name: string, args: unknown = {}): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };

const WEATHER: Weather = {
  place: "Pune, Maharashtra, India",
  tempC: 31.2,
  feelsC: 33.4,
  humidity: 48,
  windKmh: 12.6,
  code: 2,
  description: "Partly cloudy",
  isDay: true,
  hours: Array.from({ length: 24 }, (_, i) => ({ label: `${String(i).padStart(2, "0")}:00`, tempC: 20 + i / 2, rainPct: i })),
};
const SYSTEM = "platform: win32 10.0 (x64)\nhost: PC\ncpu: AMD Ryzen x16\ncpu load: 37%\nmemory: 6.0 GB free of 24.0 GB\ndisk: 120.5 GB free of 476.0 GB (C:\\)\nuptime: 14.2 hours";

let emitted: ServerMsg[];
let stage: StageState;
let db: ReturnType<typeof openDb>;
let getWeather: ReturnType<typeof vi.fn<WeatherService["get"]>>;
let exec: ReturnType<typeof vi.fn>;
let build: (provider: FakeProvider, opts?: { weather?: boolean }) => Agent;
const ctx = (trust: "owner" | "guest" = "owner") => ({ trust, emit: (m: ServerMsg) => emitted.push(m), ip: "9.9.9.9" });
const lastTool = (p: FakeProvider, n = 1) => JSON.stringify(p.calls[n]!.messages.at(-1));
const ids = () => stage.snapshot().objects.map((o) => o.id);

beforeEach(async () => {
  emitted = [];
  stage = new StageState();
  getWeather = vi.fn<WeatherService["get"]>(async () => ({ ok: true, weather: WEATHER }));
  exec = vi.fn(async () => ({ ok: true, output: SYSTEM, truncated: false }));
  const dir = mkdtempSync(join(tmpdir(), "friend-visual-"));
  db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  const config = loadConfig(dir);
  config.hud.layout = "classic"; // the gauge cards belong to the classic screen; the orbital one brings up a live instrument
  const policy = new PolicyEngine(db, config);
  build = (provider, o = {}) =>
    new Agent({
      provider,
      policy,
      approvals: new Approvals({ auth, policy, audit, db }, 100),
      devices: { exec, hasOnline: () => true, targetName: () => "pc" } as never,
      stage,
      db,
      audit,
      config,
      assistantName: () => "Jarvis",
      ...(o.weather === false ? {} : { weather: { get: getWeather } }),
    });
});

describe("weather.get", () => {
  it("is read-only, so it runs without a card, and draws the forecast by itself", async () => {
    const p = new FakeProvider([[call("1", "weather.get", { city: "Pune" }), done], [text("It is 31 degrees."), done]]);
    await build(p).runTurn("I need a forecast, can you look?", ctx()); // no city named, so the model decides
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
    expect(getWeather).toHaveBeenCalledWith("Pune");
    expect(ids().sort()).toEqual(["weather-hours", "weather-humidity", "weather-now", "weather-wind"]);
    expect(emitted.filter((m) => m.type === "stage" && m.command.cmd === "show")).toHaveLength(4); // every picture was also sent to the screen
    expect(lastTool(p)).toContain("already on the screen");
    expect(lastTool(p)).toContain("31");
  });

  it("replaces whatever was on the screen, so the forecast always fits", async () => {
    for (let i = 0; i < 12; i++) stage.apply({ cmd: "show", object: { id: `old-${i}`, type: "card", props: { text: "x" }, placement: "auto" } });
    const p = new FakeProvider([[call("1", "weather.get", { city: "Pune" }), done], [text("ok"), done]]);
    await build(p).runTurn("weather", ctx());
    expect(ids().every((id) => id.startsWith("weather-"))).toBe(true);
    expect(emitted.some((m) => m.type === "stage" && m.command.cmd === "clear")).toBe(true);
  });

  it("tells the model plainly when the lookup fails, and puts nothing on the screen", async () => {
    getWeather.mockResolvedValueOnce({ ok: false, error: 'I could not find a place called "Nowhereville".' });
    const p = new FakeProvider([[call("1", "weather.get", { city: "Nowhereville" }), done], [text("sorry"), done]]);
    await build(p).runTurn("weather", ctx());
    expect(JSON.parse(lastTool(p)).content[0]).toMatchObject({ isError: true, content: expect.stringContaining("Nowhereville") });
    expect(ids()).toEqual([]);
  });

  it("needs a city, and says so when there is no weather service", async () => {
    const p = new FakeProvider([[call("1", "weather.get", {}), done], [text("ok"), done]]);
    await build(p).runTurn("weather", ctx());
    expect(lastTool(p)).toMatch(/Invalid arguments/);
    const q = new FakeProvider([[call("1", "weather.get", { city: "Pune" }), done], [text("ok"), done]]);
    await build(q, { weather: false }).runTurn("weather", ctx());
    expect(lastTool(q)).toContain("Weather is not available.");
  });

  it("is never available to a guest", async () => {
    const p = new FakeProvider([[call("1", "weather.get", { city: "Pune" }), done], [text("no"), done]]);
    await build(p).runTurn("weather", ctx("guest"));
    expect(getWeather).not.toHaveBeenCalled();
    expect(p.calls[0]!.tools).toEqual([]);
  });
});

describe("system.info", () => {
  it("puts CPU, memory and disk gauges on the screen without the model doing anything more", async () => {
    const p = new FakeProvider([[call("1", "system.info"), done], [text("Everything looks fine."), done]]);
    await build(p).runTurn("how is my computer doing?", ctx());
    expect(ids().sort()).toEqual(["stats-cpu", "stats-cpuinfo", "stats-disk", "stats-memory", "stats-uptime"]);
    const gauges = stage.snapshot().objects.filter((o) => o.type === "gauge");
    expect(gauges.map((g) => (g.props as { value: number }).value).sort()).toEqual([37, 75, 75]);
    expect(lastTool(p)).toContain("already on the screen");
    expect(lastTool(p)).toContain("memory: 6.0 GB free"); // the model still gets the real numbers
  });

  it("leaves the text alone when the device reports something it cannot draw", async () => {
    exec.mockResolvedValueOnce({ ok: true, output: "nothing recognisable", truncated: false });
    const p = new FakeProvider([[call("1", "system.info"), done], [text("ok"), done]]);
    await build(p).runTurn("stats", ctx());
    expect(ids()).toEqual([]);
    expect(lastTool(p)).not.toContain("already on the screen");
  });
});

describe("announcing without acting", () => {
  it("asks once for the tool call when the model only says it will, and then the tool runs", async () => {
    const p = new FakeProvider([
      [text("Got it. I'll run the system information command now."), done],
      [call("1", "system.info"), done],
      [text("All good."), done],
    ]);
    await build(p).runTurn("go ahead and check the machine", ctx());
    expect(exec).toHaveBeenCalledTimes(1);
    const nudge = p.calls[1]!.messages.at(-1)!;
    expect(nudge.role).toBe("user");
    expect(JSON.stringify(nudge)).toMatch(/call the tool now/i);
    expect(ids()).toContain("stats-cpu");
  });

  it("does not keep nagging: one reminder per turn", async () => {
    const p = new FakeProvider([[text("I'll fetch it now."), done], [text("Let me check that now."), done]]);
    await build(p).runTurn("stats", ctx());
    expect(p.calls).toHaveLength(2);
  });

  it("does not remind after an ordinary answer, a question or a reply that did call a tool", async () => {
    for (const script of [[[text("Hello! How can I help?"), done]], [[text("Would you like me to fetch the weather?"), done]], [[text("I'll fetch it."), call("1", "system.info"), done], [text("Done."), done]]]) {
      const p = new FakeProvider(script);
      await build(p).runTurn("hi", ctx());
      expect(p.calls.every((c) => !JSON.stringify(c.messages).includes("call the tool now"))).toBe(true);
    }
  });

  it("never reminds a guest, and never stores the reminder in the conversation history", async () => {
    const g = new FakeProvider([[text("I'll fetch it now."), done]]);
    await build(g).runTurn("stats", ctx("guest"));
    expect(g.calls).toHaveLength(1);
    const p = new FakeProvider([[text("I'll fetch it now."), done], [text("ok"), done]]);
    await build(p).runTurn("stats", ctx());
    expect(JSON.stringify(db.prepare("select content_json from messages").all())).not.toContain("call the tool now");
  });
});

describe("the prompt asks for pictures and for action", () => {
  const { system } = promptParts("Jarvis", "scene=conversation", "owner", [], "2026-10-08T12:00:00+05:30");

  it("tells the model to show information on the screen as well as say it, with the right object for each kind", () => {
    expect(system).toMatch(/SEE answers/);
    for (const kind of ["gauge", "chart", "table", "timeline", "graph", "sandbox"]) expect(system).toContain(kind);
  });

  it("tells the model to act instead of announcing, and to use the real weather and system tools", () => {
    expect(system).toMatch(/never say you will do something/i);
    expect(system).toContain("weather.get");
    expect(system).toContain("system.info");
    expect(system).toMatch(/never curl/i);
    expect(system).toMatch(/never invent numbers/i);
  });

  it("keeps the tool descriptions short, because a small model reads them on every request", () => {
    const show = TOOL_DEFS.find((t) => t.name === "stage.show")!;
    expect(show.description.length).toBeLessThan(1500);
    expect(show.description).toContain("sandbox");
    expect(show.description).toMatch(/Example/);
  });
});
