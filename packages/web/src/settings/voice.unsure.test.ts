import { describe, expect, it } from "vitest";
import { diffSettings, type SettingsView } from "./settingsApi";

const view = (unsure?: "pin" | "guest") => ({ provider: "claude", model: "m", apiKeySet: false, view: "companion", look: {}, ollama: {}, claudeCode: {}, voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "x", sttModel: "small", ...(unsure ? { unsure } : {}) } }) as unknown as SettingsView;

describe("the choice for a voice that is close but not sure", () => {
  it("is sent when it changes, and only then", () => {
    expect(diffSettings(view("pin"), view("pin"), "")).toEqual({});
    expect(diffSettings(view("pin"), view("guest"), "")).toEqual({ voice: { unsure: "guest" } });
    expect(diffSettings(view("guest"), view("pin"), "")).toEqual({ voice: { unsure: "pin" } });
  });
});
