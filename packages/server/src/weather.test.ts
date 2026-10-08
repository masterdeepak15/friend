import { StageCommand } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { WeatherService, describeWeather, weatherScene, weatherSummary, type Weather } from "./weather";

const GEO = { results: [{ name: "Pune", country: "India", admin1: "Maharashtra", latitude: 18.5196, longitude: 73.8553, timezone: "Asia/Kolkata" }] };
const hours = Array.from({ length: 48 }, (_, i) => `2026-10-${i < 24 ? "08" : "09"}T${String(i % 24).padStart(2, "0")}:00`);
const FORECAST = {
  current: { time: "2026-10-08T14:15", temperature_2m: 31.2, relative_humidity_2m: 48, apparent_temperature: 33.4, wind_speed_10m: 12.6, weather_code: 2, is_day: 1 },
  hourly: {
    time: hours,
    temperature_2m: hours.map((_, i) => 20 + (i % 24) / 2),
    precipitation_probability: hours.map((_, i) => (i % 24) * 2),
  },
};

type Handler = (url: URL) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function service(handler: Handler, timeoutMs = 2000) {
  const urls: URL[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return handler(url);
  }) as typeof fetch;
  return { svc: new WeatherService(fetchFn, timeoutMs), urls };
}
const ok = (): Handler => (u) => (u.hostname === "geocoding-api.open-meteo.com" ? json(GEO) : json(FORECAST));

describe("WeatherService.get", () => {
  it("finds the place, then reads its forecast, and returns tidy numbers", async () => {
    const { svc } = service(ok());
    const r = await svc.get("Pune");
    expect(r.ok).toBe(true);
    const w = (r as { ok: true; weather: Weather }).weather;
    expect(w).toMatchObject({ place: "Pune, Maharashtra, India", tempC: 31.2, feelsC: 33.4, humidity: 48, windKmh: 12.6, code: 2, isDay: true, description: "Partly cloudy" });
    expect(w.hours).toHaveLength(24);
    expect(w.hours[0]).toMatchObject({ label: "14:00", tempC: 27 });
    expect(w.hours[23]!.label).toBe("13:00"); // the next 24 hours, starting with the current one
  });

  it("only ever talks to the two Open-Meteo hosts, and never lets the city text change the host or path", async () => {
    const { svc, urls } = service(ok());
    await svc.get("Pune/../../evil.example?x=1&y=2#frag");
    expect(urls.map((u) => u.hostname)).toEqual(["geocoding-api.open-meteo.com", "api.open-meteo.com"]);
    expect(urls[0]!.pathname).toBe("/v1/search");
    expect(urls[0]!.searchParams.get("name")).toBe("Pune/../../evil.example?x=1&y=2#frag");
    expect(urls.every((u) => u.protocol === "https:")).toBe(true);
    expect(urls[1]!.searchParams.get("latitude")).toBe("18.5196");
  });

  it("says plainly when the place is unknown", async () => {
    const { svc } = service((u) => (u.hostname.startsWith("geocoding") ? json({}) : json(FORECAST)));
    expect(await svc.get("Nowhereville")).toEqual({ ok: false, error: 'I could not find a place called "Nowhereville".' });
  });

  it("refuses an empty or very long city without any request", async () => {
    const { svc, urls } = service(ok());
    expect(await svc.get("   ")).toEqual({ ok: false, error: "Tell me which city." });
    expect((await svc.get("x".repeat(81))).ok).toBe(false);
    expect(urls).toHaveLength(0);
  });

  it("reports a network failure, an error status, a timeout and an unexpected reply in words", async () => {
    const down = service(() => {
      throw new TypeError("fetch failed: ECONNREFUSED 10.0.0.1");
    });
    expect(await down.svc.get("Pune")).toEqual({ ok: false, error: "I could not reach the weather service. Check the internet connection." });
    const bad = service(() => json({ error: true }, 500));
    expect(await bad.svc.get("Pune")).toEqual({ ok: false, error: "The weather service is not answering right now." });
    const slow = service(() => new Promise<Response>(() => {}), 50);
    expect(await slow.svc.get("Pune")).toEqual({ ok: false, error: "The weather service took too long to answer." });
    const odd = service((u) => (u.hostname.startsWith("geocoding") ? json(GEO) : json({ current: { temperature_2m: "hot" } })));
    expect(await odd.svc.get("Pune")).toEqual({ ok: false, error: "The weather service sent something I could not read." });
  });

  it("does not leak internal error text", async () => {
    const { svc } = service(() => {
      throw new Error("secret C:\\path\\token=abc");
    });
    const r = await svc.get("Pune");
    expect(JSON.stringify(r)).not.toMatch(/secret|token|C:/);
  });
});

describe("describeWeather", () => {
  it.each([
    [0, "Clear sky"],
    [3, "Overcast"],
    [45, "Fog"],
    [61, "Light rain"],
    [75, "Heavy snow"],
    [95, "Thunderstorm"],
    [999, "Unknown conditions"],
  ])("code %i is %s", (code, text) => expect(describeWeather(code)).toBe(text));
});

describe("what goes on the screen", () => {
  const w: Weather = {
    place: "Pune, India",
    tempC: 31.2,
    feelsC: 33.4,
    humidity: 48,
    windKmh: 12.6,
    code: 2,
    description: "Partly cloudy",
    isDay: true,
    hours: Array.from({ length: 24 }, (_, i) => ({ label: `${String(i).padStart(2, "0")}:00`, tempC: 20 + i / 2, rainPct: i * 2 })),
  };

  it("builds valid stage commands: the temperature, humidity, wind, and a 24-hour chart", () => {
    const cmds = weatherScene(w);
    for (const c of cmds) expect(StageCommand.safeParse(c).success, JSON.stringify(c)).toBe(true);
    const shown = cmds.flatMap((c) => (c.cmd === "show" ? [c.object] : []));
    expect(shown.every((o) => o.id.startsWith("weather-"))).toBe(true);
    expect(shown.find((o) => o.id === "weather-now")).toMatchObject({ type: "stat", props: { label: "Pune, India", value: "31", unit: "°C" } });
    expect(shown.find((o) => o.id === "weather-now")!.props.delta).toContain("Partly cloudy");
    expect(shown.find((o) => o.id === "weather-humidity")).toMatchObject({ type: "gauge", props: { value: 48 } });
    expect(shown.find((o) => o.id === "weather-wind")).toMatchObject({ type: "stat", props: { value: "13", unit: "km/h" } });
    const chart = shown.find((o) => o.id === "weather-hours")!;
    expect(chart.type).toBe("chart");
    expect((chart.props.labels as string[]).length).toBe(24);
    expect((chart.props.series as { name: string; values: number[] }[]).map((s) => s.name)).toEqual(["Temperature °C", "Rain chance %"]);
    expect(cmds[0]).toEqual({ cmd: "scene", mode: "multi" });
  });

  it("gives the model a short factual summary that says the screen is already showing it", () => {
    const s = weatherSummary(w);
    expect(s).toContain("Pune, India");
    expect(s).toContain("31");
    expect(s).toMatch(/already on the screen/i);
    expect(s.length).toBeLessThan(500);
  });
});
