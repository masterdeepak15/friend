import type { StageCommand } from "@friend/protocol";
import { z } from "zod";

/** Weather from Open-Meteo: free, no account and no API key. Only these two fixed hosts are ever contacted. */
const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";
const MAX_REPLY_CHARS = 300_000;
const MAX_CITY_CHARS = 80;

export interface Weather {
  place: string;
  tempC: number;
  feelsC: number;
  humidity: number;
  windKmh: number;
  code: number;
  description: string;
  isDay: boolean;
  /** The next 24 hours, starting with the current one. */
  hours: { label: string; tempC: number; rainPct: number | null }[];
}

export type WeatherResult = { ok: true; weather: Weather } | { ok: false; error: string };

const CODES: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Heavy freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Heavy freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Light showers", 81: "Showers", 82: "Heavy showers", 85: "Light snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
};
export const describeWeather = (code: number): string => CODES[code] ?? "Unknown conditions";

const GeocodeReply = z.object({
  results: z
    .array(z.object({ name: z.string(), country: z.string().optional(), admin1: z.string().optional(), latitude: z.number(), longitude: z.number() }))
    .min(1),
});
const ForecastReply = z.object({
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    relative_humidity_2m: z.number(),
    apparent_temperature: z.number(),
    wind_speed_10m: z.number(),
    weather_code: z.number(),
    is_day: z.number(),
  }),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(z.number().nullable()),
    precipitation_probability: z.array(z.number().nullable()).optional(),
  }),
});

class Failure extends Error {}

export class WeatherService {
  constructor(
    private fetchFn: typeof fetch = fetch,
    private timeoutMs = 12_000, // generous: the PC may be busy with a local model
  ) {}

  async get(city: string): Promise<WeatherResult> {
    const name = city.replace(/\s+/g, " ").trim();
    if (!name) return { ok: false, error: "Tell me which city." };
    if (name.length > MAX_CITY_CHARS) return { ok: false, error: "That city name is too long." };
    try {
      const geo = await this.json(`${GEOCODE}?${new URLSearchParams({ name, count: "1", language: "en", format: "json" })}`);
      const place = GeocodeReply.safeParse(geo);
      if (!place.success) {
        // an unknown place comes back without "results"; anything else shaped differently is unreadable
        if (geo && typeof geo === "object" && !("results" in geo)) return { ok: false, error: `I could not find a place called "${name}".` };
        throw new Failure("The weather service sent something I could not read.");
      }
      const p = place.data.results[0]!;
      const query = new URLSearchParams({
        latitude: String(p.latitude),
        longitude: String(p.longitude),
        current: "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code,is_day",
        hourly: "temperature_2m,precipitation_probability",
        forecast_days: "2",
        timezone: "auto",
      });
      const parsed = ForecastReply.safeParse(await this.json(`${FORECAST}?${query}`));
      if (!parsed.success) throw new Failure("The weather service sent something I could not read.");
      const { current, hourly } = parsed.data;
      const from = Math.max(0, hourly.time.findIndex((t) => t >= `${current.time.slice(0, 13)}:00`));
      const hours = hourly.time
        .slice(from, from + 24)
        .map((t, i) => ({ label: t.slice(11, 16), tempC: hourly.temperature_2m[from + i] ?? Number.NaN, rainPct: hourly.precipitation_probability?.[from + i] ?? null }))
        .filter((h) => Number.isFinite(h.tempC));
      return {
        ok: true,
        weather: {
          place: [p.name, p.admin1, p.country].filter(Boolean).join(", "),
          tempC: current.temperature_2m,
          feelsC: current.apparent_temperature,
          humidity: current.relative_humidity_2m,
          windKmh: current.wind_speed_10m,
          code: current.weather_code,
          description: describeWeather(current.weather_code),
          isDay: current.is_day === 1,
          hours,
        },
      };
    } catch (e) {
      // only our own plain messages are passed on; raw errors can carry paths or addresses
      return { ok: false, error: e instanceof Failure ? e.message : "I could not reach the weather service. Check the internet connection." };
    }
  }

  private async json(url: string): Promise<unknown> {
    const ctl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const res = await Promise.race([
        this.fetchFn(url, { signal: ctl.signal, headers: { accept: "application/json" } }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ctl.abort();
            reject(new Failure("The weather service took too long to answer."));
          }, this.timeoutMs);
        }),
      ]);
      if (!res.ok) throw new Failure("The weather service is not answering right now.");
      const body = await res.text();
      if (body.length > MAX_REPLY_CHARS) throw new Failure("The weather service sent something I could not read.");
      try {
        return JSON.parse(body);
      } catch {
        throw new Failure("The weather service sent something I could not read.");
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** The pictures for a forecast: placed by the server itself, so they appear whatever the model does next. */
export function weatherScene(w: Weather): StageCommand[] {
  const show = (id: string, type: "stat" | "gauge" | "chart", props: Record<string, unknown>, placement: "auto" = "auto"): StageCommand => ({
    cmd: "show",
    object: { id, type, props, placement },
  });
  return [
    { cmd: "scene", mode: "multi" },
    show("weather-now", "stat", { label: w.place, value: String(Math.round(w.tempC)), unit: "°C", delta: `${w.description}, feels like ${Math.round(w.feelsC)}°C` }),
    show("weather-humidity", "gauge", { label: "Humidity", value: Math.round(w.humidity), unit: "%" }),
    show("weather-wind", "stat", { label: "Wind", value: String(Math.round(w.windKmh)), unit: "km/h" }),
    show("weather-hours", "chart", {
      title: "Next 24 hours",
      kind: "line",
      labels: w.hours.map((h) => h.label),
      series: [
        { name: "Temperature °C", values: w.hours.map((h) => Math.round(h.tempC * 10) / 10) },
        { name: "Rain chance %", values: w.hours.map((h) => h.rainPct ?? 0) },
      ],
    }),
  ];
}

/** What the model is told: short, and clear that the screen is already done. */
export function weatherSummary(w: Weather): string {
  const maxRain = Math.max(0, ...w.hours.map((h) => h.rainPct ?? 0));
  return (
    `${w.place}: ${w.description}, ${Math.round(w.tempC)}°C (feels like ${Math.round(w.feelsC)}°C), humidity ${Math.round(w.humidity)}%, wind ${Math.round(w.windKmh)} km/h, ` +
    `highest rain chance in the next 24 hours ${Math.round(maxRain)}%. The temperature, humidity, wind and a 24-hour chart are already on the screen; just say a short summary.`
  );
}
