import { invocationNameProblem } from "./invocation";
import { LEAD_INS, LEAD_INTENTS, type Lang } from "./phrases";

export type PackageFile = "skill.json" | "en-IN.json" | "hi-IN.json";
export const PACKAGE_FILES: readonly PackageFile[] = ["skill.json", "en-IN.json", "hi-IN.json"];

interface Intent {
  name: string;
  samples: string[];
  slots?: { name: string; type: string }[];
}

/** What the owner can say to reach each fixed question. Plain lower-case words only, as Amazon requires. */
const FIXED: Record<Lang, { PortfolioIntent: string[]; TasksIntent: string[]; StatusIntent: string[]; ReadyIntent: string[]; weather: string[] }> = {
  en: {
    PortfolioIntent: ["how is my portfolio", "how is my portfolio doing", "how are my stocks doing", "what is my portfolio", "my portfolio", "portfolio"],
    TasksIntent: ["what are my tasks", "what do i have to do", "what is on my list", "read my tasks", "my tasks"],
    StatusIntent: ["status", "give me the status", "what is the status", "are you there"],
    ReadyIntent: ["is it ready", "is it done", "are you done", "do you have an answer", "what is the answer"],
    weather: ["what is the weather in {city}", "how is the weather in {city}", "weather in {city}", "tell me the weather in {city}"],
  },
  hi: {
    PortfolioIntent: ["मेरा पोर्टफोलियो कैसा है", "मेरा पोर्टफोलियो कैसा चल रहा है", "मेरे शेयर कैसे हैं", "मेरा पोर्टफोलियो", "पोर्टफोलियो"],
    TasksIntent: ["मेरे काम क्या हैं", "मुझे क्या करना है", "मेरी सूची में क्या है", "मेरे काम पढ़ो", "मेरे काम"],
    StatusIntent: ["स्थिति", "स्थिति बताओ", "क्या तुम यहाँ हो"],
    ReadyIntent: ["क्या तैयार है", "जवाब तैयार है", "हो गया क्या", "क्या जवाब है"],
    weather: ["{city} में मौसम कैसा है", "{city} का मौसम कैसा है", "{city} का मौसम"],
  },
};

const BUILT_IN = ["AMAZON.CancelIntent", "AMAZON.HelpIntent", "AMAZON.StopIntent", "AMAZON.FallbackIntent", "AMAZON.NavigateHomeIntent"];

function intents(lang: Lang): Intent[] {
  const f = FIXED[lang];
  return [
    ...BUILT_IN.map((name) => ({ name, samples: [] })),
    { name: "PortfolioIntent", samples: f.PortfolioIntent },
    { name: "WeatherIntent", slots: [{ name: "city", type: "AMAZON.SearchQuery" }], samples: f.weather },
    { name: "TasksIntent", samples: f.TasksIntent },
    { name: "StatusIntent", samples: f.StatusIntent },
    { name: "ReadyIntent", samples: f.ReadyIntent },
    // open questions: one free-text slot per sentence, so each lead-in is its own intent and the engine can put the sentence back together
    ...LEAD_INTENTS.map((name) => ({ name, slots: [{ name: "q", type: "AMAZON.SearchQuery" }], samples: [`${LEAD_INS[name][lang]} {q}`] })),
  ];
}

const model = (invocationName: string, lang: Lang): string =>
  JSON.stringify({ interactionModel: { languageModel: { invocationName, intents: intents(lang), types: [] } } }, null, 2);

const SKILL_NAME = "Friend Assistant";
const locale = (lang: Lang, invocationName: string) => ({
  name: SKILL_NAME,
  summary: lang === "hi" ? "अपने फ्रेंड असिस्टेंट से बात करें।" : "Talk to your own Friend assistant.",
  description: lang === "hi" ? "यह आपके अपने फ्रेंड असिस्टेंट के लिए निजी स्किल है। आपके अपने कंप्यूटर पर चलता है।" : "A private skill for your own self-hosted Friend assistant. It talks to your own computer.",
  examplePhrases: [lang === "hi" ? `अलेक्सा, ${invocationName} से मेरा पोर्टफोलियो कैसा है पूछो` : `Alexa, ask ${invocationName} how my portfolio is`, `Alexa, open ${invocationName}`, `Alexa, ask ${invocationName} what is on my list`],
  keywords: ["friend", "assistant"],
});

/**
 * The three files the owner pastes into the Alexa developer console: the skill manifest (with Friend's address as the endpoint) and
 * the interaction models for English (India) and Hindi (India). Nothing is uploaded anywhere by Friend.
 */
export function buildSkillPackage(o: { invocationName: string; endpoint: string }): Record<PackageFile, string> {
  const problem = invocationNameProblem(o.invocationName);
  if (problem) throw new Error(problem);
  if (!/^https:\/\/[^\s/]+\/\S*$/.test(o.endpoint)) throw new Error("The address must be an https address, such as https://your-address/api/alexa.");
  const manifest = {
    manifest: {
      manifestVersion: "1.0",
      publishingInformation: {
        locales: { "en-IN": locale("en", o.invocationName), "hi-IN": locale("hi", o.invocationName) },
        isAvailableWorldwide: false,
        distributionCountries: ["IN"],
        category: "ORGANIZERS_AND_ASSISTANTS",
        testingInstructions: "A private skill for its owner's own self-hosted assistant. It is used in development mode only.",
      },
      apis: { custom: { endpoint: { uri: o.endpoint, sslCertificateType: "Trusted" } } },
      privacyAndCompliance: { allowsPurchases: false, usesPersonalInfo: false, isChildDirected: false, isExportCompliant: true, containsAds: false },
    },
  };
  return {
    "skill.json": JSON.stringify(manifest, null, 2),
    "en-IN.json": model(o.invocationName, "en"),
    "hi-IN.json": model(o.invocationName, "hi"),
  };
}
