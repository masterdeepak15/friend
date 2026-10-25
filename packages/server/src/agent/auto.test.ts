import type { ServerMsg } from "@friend/protocol";
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

const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const WEATHER: Weather = {
  place: "Pune, India", tempC: 31, feelsC: 33, humidity: 48, windKmh: 12, code: 2, description: "Partly cloudy", isDay: true,
  hours: Array.from({ length: 24 }, (_, i) => ({ label: `${String(i).padStart(2, "0")}:00`, tempC: 20 + i / 2, rainPct: i })),
};
const SYSTEM = "cpu: AMD x16\ncpu load: 37%\nmemory: 6.0 GB free of 24.0 GB\ndisk: 120.5 GB free of 476.0 GB (C:\\)\nuptime: 14.2 hours";

let emitted: ServerMsg[];
let stage: StageState;
let db: ReturnType<typeof openDb>;
let getWeather: ReturnType<typeof vi.fn<WeatherService["get"]>>;
let exec: ReturnType<typeof vi.fn>;
let build: (provider: FakeProvider, opts?: { weather?: boolean }) => Agent;
const ctx = (trust: "owner" | "guest" = "owner") => ({ trust, emit: (m: ServerMsg) => emitted.push(m), ip: "9.9.9.9" });
const ids = () => stage.snapshot().objects.map((o) => o.id).sort();

beforeEach(async () => {
  emitted = [];
  stage = new StageState();
  getWeather = vi.fn<WeatherService["get"]>(async () => ({ ok: true, weather: WEATHER }));
  exec = vi.fn(async () => ({ ok: true, output: SYSTEM, truncated: false }));
  const dir = mkdtempSync(join(tmpdir(), "friend-auto-"));
  db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  const config = loadConfig(dir);
  config.hud.layout = "classic"; // these tests are about the gauge cards the classic screen gets; the orbital screen has a live instrument instead (see instruments.test.ts)
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

describe("clear data requests are answered with the real tools before the model speaks", () => {
  it("runs weather.get and system.info itself, so the graphs are on the screen and the model only summarizes", async () => {
    const p = new FakeProvider([[text("It is 31 degrees and your PC is fine."), done]]);
    await build(p).runTurn("Show me the weather in Pune and also my computer stats on the screen.", ctx());
    expect(getWeather).toHaveBeenCalledWith("Pune");
    expect(exec).toHaveBeenCalledWith("system.info", {}, expect.anything(), expect.anything());
    // both sets of pictures are on the screen together: the second scene does not wipe out the first
    expect(ids()).toEqual([
      "stats-cpu", "stats-cpuinfo", "stats-disk", "stats-memory", "stats-uptime",
      "weather-hours", "weather-humidity", "weather-now", "weather-wind",
    ]);
    expect(p.calls).toHaveLength(1); // one short model call, not a chain of them
    const m = p.calls[0]!.messages;
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect(JSON.stringify(m[2])).toContain("Pune, India: Partly cloudy");
    expect(JSON.stringify(m[4])).toContain("memory: 6.0 GB free");
    expect(emitted.some((e) => e.type === "approval.request")).toBe(false);
  });

  it("gives every synthetic call its own id, and pairs each call with its result", async () => {
    const p = new FakeProvider([[text("ok"), done]]);
    await build(p).runTurn("weather in Pune and my computer stats", ctx());
    const m = p.calls[0]!.messages;
    const callIds = [m[1], m[3]].map((x) => (x!.content[0] as { id: string }).id);
    const resultIds = [m[2], m[4]].map((x) => (x!.content[0] as { toolUseId: string }).toolUseId);
    expect(new Set(callIds).size).toBe(2);
    expect(resultIds).toEqual(callIds);
  });

  it("puts the weather alone on the screen when that is all that was asked", async () => {
    const p = new FakeProvider([[text("ok"), done]]);
    await build(p).runTurn("What is the weather in Pune?", ctx());
    expect(ids()).toEqual(["weather-hours", "weather-humidity", "weather-now", "weather-wind"]);
    expect(p.calls).toHaveLength(1);
  });

  it("starts each new request with a clean screen, so old pictures do not pile up", async () => {
    const agent = build(new FakeProvider([[text("one"), done], [text("two"), done]]));
    await agent.runTurn("weather in Pune", ctx());
    expect(ids().every((i) => i.startsWith("weather-"))).toBe(true);
    await agent.runTurn("my computer stats", ctx());
    expect(ids().every((i) => i.startsWith("stats-"))).toBe(true); // the forecast from the last request is gone
  });

  it("keeps the calls in the saved conversation, so later turns see what happened", async () => {
    const p = new FakeProvider([[text("ok"), done]]);
    await build(p).runTurn("weather in Pune", ctx());
    const roles = (db.prepare("select role from messages order by id").all() as { role: string }[]).map((r) => r.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("tells the model plainly when the data could not be had, and the turn carries on", async () => {
    getWeather.mockResolvedValueOnce({ ok: false, error: "I could not reach the weather service. Check the internet connection." });
    const p = new FakeProvider([[text("I could not get the weather."), done]]);
    await build(p).runTurn("weather in Pune", ctx());
    expect(JSON.stringify(p.calls[0]!.messages[2])).toContain("could not reach the weather service");
    expect(ids()).toEqual([]);
  });

  it("works the same without a weather service, with the reason as the result", async () => {
    const p = new FakeProvider([[text("ok"), done]]);
    await build(p, { weather: false }).runTurn("weather in Pune", ctx());
    expect(JSON.stringify(p.calls[0]!.messages[2])).toContain("Weather is not available.");
  });

  it("leaves ordinary messages to the model alone", async () => {
    const p = new FakeProvider([[text("Hello!"), done]]);
    await build(p).runTurn("hello there", ctx());
    expect(getWeather).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(p.calls[0]!.messages.map((x) => x.role)).toEqual(["user"]);
  });

  it("asks the model, not the weather service, when no city was named", async () => {
    const p = new FakeProvider([[text("Which city?"), done]]);
    await build(p).runTurn("what is the weather like?", ctx());
    expect(getWeather).not.toHaveBeenCalled();
  });

  it("does nothing automatic for a guest", async () => {
    const p = new FakeProvider([[text("I can only help the owner."), done]]);
    await build(p).runTurn("weather in Pune and my computer stats", ctx("guest"));
    expect(getWeather).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(p.calls[0]!.messages).toHaveLength(1);
  });
});
