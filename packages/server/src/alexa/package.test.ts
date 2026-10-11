import { describe, expect, it } from "vitest";
import { invocationNameProblem } from "./invocation";
import { buildSkillPackage } from "./package";
import { LEAD_INS, LEAD_INTENTS } from "./phrases";

const make = () => buildSkillPackage({ invocationName: "jarvis assistant", endpoint: "https://friend.example.com/api/alexa" });
type Intent = { name: string; samples: string[]; slots?: { name: string; type: string }[] };
const model = (file: "en-IN.json" | "hi-IN.json") => JSON.parse(make()[file]!).interactionModel.languageModel as { invocationName: string; intents: Intent[]; types: unknown[] };

describe("the manifest", () => {
  it("is JSON that points at Friend's address and says it is a trusted certificate", () => {
    const m = JSON.parse(make()["skill.json"]!).manifest;
    expect(m.apis.custom.endpoint).toEqual({ uri: "https://friend.example.com/api/alexa", sslCertificateType: "Trusted" });
    expect(Object.keys(m.publishingInformation.locales).sort()).toEqual(["en-IN", "hi-IN"]);
    expect(m.manifestVersion).toBe("1.0");
    expect(m.publishingInformation.locales["en-IN"].name).toBe("Friend Assistant");
  });

  it("is refused for an address that is not https, and for a bad invocation name", () => {
    expect(() => buildSkillPackage({ invocationName: "jarvis assistant", endpoint: "http://friend.example.com/api/alexa" })).toThrow(/https/i);
    expect(() => buildSkillPackage({ invocationName: "jarvis assistant", endpoint: "" })).toThrow();
    expect(() => buildSkillPackage({ invocationName: "ask jarvis", endpoint: "https://friend.example.com/api/alexa" })).toThrow(/ask/i);
    expect(JSON.parse(buildSkillPackage({ invocationName: "maya", endpoint: "https://friend.example.com/api/alexa" })["en-IN.json"]!).interactionModel.languageModel.invocationName).toBe("maya");
  });
});

describe.each(["en-IN.json", "hi-IN.json"] as const)("the %s interaction model", (file) => {
  const m = () => model(file);

  it("uses the invocation name, which follows Amazon's rules", () => {
    expect(m().invocationName).toBe("jarvis assistant");
    expect(invocationNameProblem(m().invocationName)).toBeNull();
  });

  it("has every intent the engine understands, once each", () => {
    const names = m().intents.map((i) => i.name);
    for (const n of ["PortfolioIntent", "WeatherIntent", "TasksIntent", "StatusIntent", "ReadyIntent", ...LEAD_INTENTS, "AMAZON.HelpIntent", "AMAZON.StopIntent", "AMAZON.CancelIntent", "AMAZON.FallbackIntent", "AMAZON.NavigateHomeIntent"]) {
      expect(names, n).toContain(n);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every custom intent samples, and the built-in ones none", () => {
    for (const i of m().intents) expect(i.samples.length > 0, i.name).toBe(!i.name.startsWith("AMAZON."));
  });

  it("starts each open-question sample with its lead-in and has exactly one {q}", () => {
    const lang = file.startsWith("hi") ? "hi" : "en";
    for (const name of LEAD_INTENTS) {
      const intent = m().intents.find((i) => i.name === name)!;
      expect(intent.slots).toEqual([{ name: "q", type: "AMAZON.SearchQuery" }]);
      for (const s of intent.samples) {
        expect(s.startsWith(LEAD_INS[name][lang] + " "), s).toBe(true);
        expect(s.match(/\{q\}/g)).toHaveLength(1);
      }
    }
  });

  it("has no sentence start used by two intents, which the console would refuse", () => {
    const lang = file.startsWith("hi") ? "hi" : "en";
    const starts = LEAD_INTENTS.map((n) => LEAD_INS[n][lang]);
    expect(new Set(starts).size).toBe(starts.length);
    expect(LEAD_INTENTS.length).toBeGreaterThanOrEqual(30);
  });

  it("never puts two slots in one sample, and always has words around a free-text slot", () => {
    for (const i of m().intents) {
      for (const s of i.samples) {
        const slots = s.match(/\{[a-zA-Z]+\}/g) ?? [];
        expect(slots.length, s).toBeLessThanOrEqual(1);
        if (slots.length === 1) expect(s.replace(slots[0]!, "").trim().length, s).toBeGreaterThan(1);
      }
    }
  });

  it("declares a slot for every slot a sample uses, and no sample is repeated", () => {
    for (const i of m().intents) {
      const used = new Set(i.samples.flatMap((s) => (s.match(/\{([a-zA-Z]+)\}/g) ?? []).map((x) => x.slice(1, -1))));
      const declared = new Set((i.slots ?? []).map((s) => s.name));
      for (const u of used) expect(declared.has(u), `${i.name}:${u}`).toBe(true);
      expect(new Set(i.samples).size).toBe(i.samples.length);
    }
  });

  it("has no capital letters or punctuation in samples, as Amazon requires", () => {
    for (const i of m().intents) for (const s of i.samples) expect(s, s).toMatch(/^[a-zऀ-ॿ{}' ]+$/);
  });
});

describe("the Hindi model", () => {
  it("has Devanagari samples", () => {
    const portfolio = model("hi-IN.json").intents.find((i) => i.name === "PortfolioIntent")!;
    expect(portfolio.samples.every((s) => /[ऀ-ॿ]/.test(s))).toBe(true);
  });
});
