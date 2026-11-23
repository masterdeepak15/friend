import { describe, expect, it } from "vitest";
import { diffSettings, type SecurityAlertsSettings, type SettingsView } from "./settingsApi";

const view = (a: SecurityAlertsSettings) => ({ provider: "claude", model: "m", apiKeySet: false, view: "companion", look: {}, ollama: {}, claudeCode: {}, voice: {}, securityAlerts: a }) as unknown as SettingsView;
const base: SecurityAlertsSettings = { enabled: true, cooldownMinutes: 15, maxPerDay: 20 };

describe("the break-in warnings in Settings", () => {
  it("sends only what changed", () => {
    expect(diffSettings(view(base), view({ ...base }), "")).toEqual({});
    expect(diffSettings(view(base), view({ ...base, enabled: false }), "")).toEqual({ securityAlerts: { enabled: false } });
    expect(diffSettings(view(base), view({ ...base, cooldownMinutes: 60, maxPerDay: 5 }), "")).toEqual({ securityAlerts: { cooldownMinutes: 60, maxPerDay: 5 } });
  });
});
