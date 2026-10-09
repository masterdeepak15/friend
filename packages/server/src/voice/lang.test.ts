import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Audit } from "../audit";
import { openDb } from "../db";
import { devanagariLanguage, languageNote, planSpeech, splitRuns } from "./lang";
import { FakeVoice } from "./service";
import { Speaker, speechText, splitSentences } from "./speaker";

describe("cutting a sentence by script", () => {
  it("keeps plain English and plain Hindi in one piece", () => {
    expect(splitRuns("Open my files.")).toEqual([{ text: "Open my files.", script: "latin" }]);
    expect(splitRuns("आज मौसम अच्छा है।")).toEqual([{ text: "आज मौसम अच्छा है।", script: "devanagari" }]);
  });

  it("cuts a mixed sentence where the script changes, and keeps spaces and punctuation with the run before", () => {
    expect(splitRuns("आज का weather बहुत अच्छा है।")).toEqual([
      { text: "आज का ", script: "devanagari" },
      { text: "weather ", script: "latin" },
      { text: "बहुत अच्छा है।", script: "devanagari" },
    ]);
    expect(splitRuns("Meeting 5 बजे, ok?")).toEqual([
      { text: "Meeting 5 ", script: "latin" },
      { text: "बजे, ", script: "devanagari" },
      { text: "ok?", script: "latin" },
    ]);
  });

  it("gives a leading number or mark to the first run, and nothing for text with no letters", () => {
    expect(splitRuns("12. नमस्ते")[0]).toEqual({ text: "12. नमस्ते", script: "devanagari" });
    expect(splitRuns("42 ...")).toEqual([]);
  });
});

describe("Hindi or Marathi", () => {
  it("tells them apart by their own words", () => {
    expect(devanagariLanguage("आज मौसम कैसा है, मैं बाहर जा रहा हूँ।")).toBe("hi");
    expect(devanagariLanguage("आज हवामान कसे आहे? मी बाहेर जात आहे.")).toBe("mr");
    expect(devanagariLanguage("तुम्ही काय करत आहात?")).toBe("mr");
    expect(devanagariLanguage("आप क्या कर रहे हैं?")).toBe("hi");
  });

  it("takes the letter ळ as Marathi, and Hindi when it is not clear", () => {
    expect(devanagariLanguage("सकाळ")).toBe("mr");
    expect(devanagariLanguage("नमस्ते")).toBe("hi");
    expect(devanagariLanguage("")).toBe("hi");
  });
});

describe("planning how to say a sentence", () => {
  const voices = { main: "en_US-amy-medium", hindi: "hi_IN-priyamvada-medium", marathi: "mr_IN-google-medium" };

  it("says plain English with the main voice, as one piece, exactly as before", () => {
    expect(planSpeech("Good morning.", voices)).toEqual([{ text: "Good morning.", voice: "en_US-amy-medium" }]);
    expect(planSpeech("Good morning.", {})).toEqual([{ text: "Good morning.", voice: undefined }]);
  });

  it("says Hindi with the Hindi voice and Marathi with the Marathi voice", () => {
    expect(planSpeech("आज मौसम अच्छा है।", voices)).toEqual([{ text: "आज मौसम अच्छा है।", voice: "hi_IN-priyamvada-medium" }]);
    expect(planSpeech("आज हवामान चांगले आहे.", voices)).toEqual([{ text: "आज हवामान चांगले आहे.", voice: "mr_IN-google-medium" }]);
  });

  it("says a mixed sentence in pieces, English words with the main voice", () => {
    expect(planSpeech("आज का weather बहुत अच्छा है।", voices)).toEqual([
      { text: "आज का ", voice: "hi_IN-priyamvada-medium" },
      { text: "weather ", voice: "en_US-amy-medium" },
      { text: "बहुत अच्छा है।", voice: "hi_IN-priyamvada-medium" },
    ]);
  });

  it("decides Hindi or Marathi for the whole sentence, so the pieces do not change voice in the middle", () => {
    const plan = planSpeech("मी आज meeting ला जात आहे.", voices);
    expect(plan.filter((p) => p.voice !== voices.main).every((p) => p.voice === "mr_IN-google-medium")).toBe(true);
  });

  it("joins a piece that is only punctuation to the one before it", () => {
    expect(planSpeech("नमस्ते Priya !", voices).map((p) => p.text).join("")).toBe("नमस्ते Priya !");
    expect(planSpeech("नमस्ते, Priya.", voices).every((p) => /[\p{L}]/u.test(p.text))).toBe(true);
  });

  it("falls back to the main voice for Devanagari when no Hindi or Marathi voice is set", () => {
    expect(planSpeech("आज मौसम अच्छा है।", { main: "en_US-amy-medium" })).toEqual([{ text: "आज मौसम अच्छा है।", voice: "en_US-amy-medium" }]);
    expect(planSpeech("आज मौसम अच्छा है।", { main: "m", hindi: "" })).toEqual([{ text: "आज मौसम अच्छा है।", voice: "m" }]);
  });
});

describe("telling the model which language to answer in", () => {
  it("says nothing for English", () => {
    expect(languageNote("open my files")).toBeNull();
    expect(languageNote("open my files", "en")).toBeNull();
  });

  it("asks for Hindi in Devanagari when Hindi was spoken or typed", () => {
    expect(languageNote("आज मौसम कैसा है", "hi")).toMatch(/Hindi.*Devanagari script/);
    expect(languageNote("aaj mausam kaisa hai", "hi")).toMatch(/speaking Hindi/); // the recognizer heard Hindi even if the text is in Roman letters
  });

  it("asks for Marathi when the words are Marathi", () => {
    expect(languageNote("आज हवामान कसे आहे?")).toMatch(/Marathi/);
    expect(languageNote("x", "mr")).toMatch(/Marathi/);
  });

  it("asks for the same mix when the owner mixes", () => {
    expect(languageNote("आज का weather बताओ")).toMatch(/mixing Hindi and English.*English words in Latin letters/);
  });
});

describe("the end of a Hindi sentence", () => {
  it("is the danda, which splits sentences like a full stop", () => {
    expect(splitSentences("आज मौसम अच्छा है। कल बारिश होगी। Okay.")).toEqual(["आज मौसम अच्छा है।", "कल बारिश होगी।", "Okay."]);
  });
  it("does not get a stray full stop added after it", () => {
    expect(speechText("आज मौसम अच्छा है।")).toBe("आज मौसम अच्छा है।");
    expect(speechText("# शीर्षक\nआज का weather")).toBe("शीर्षक. आज का weather.");
  });
});

describe("speaking a mixed reply", () => {
  const audit = () => new Audit(openDb(mkdtempSync(join(tmpdir(), "friend-lang-"))));
  const run = async (voice: FakeVoice, text: string, langs: { hindi?: string; marathi?: string } = { hindi: "hi_IN-priyamvada-medium", marathi: "mr_IN-google-medium" }) => {
    const out: ServerMsg[] = [];
    await new Speaker(voice, audit(), () => "en_US-amy-medium", () => langs).speak(text, (m) => out.push(m));
    return out;
  };

  it("uses the Hindi voice for Devanagari and the main voice for English words, in order, as separate clips", async () => {
    const voice = new FakeVoice();
    const out = await run(voice, "आज का weather बहुत अच्छा है।");
    expect(voice.voicesUsed).toEqual(["hi_IN-priyamvada-medium", "en_US-amy-medium", "hi_IN-priyamvada-medium"]);
    expect(voice.synthesized).toEqual(["आज का ", "weather ", "बहुत अच्छा है।"]);
    const ids = out.filter((m) => m.type === "audio.chunk").map((m) => (m as { id: string }).id);
    expect(new Set(ids).size).toBe(3);
  });

  it("speaks plain English exactly as before: one clip, the main voice", async () => {
    const voice = new FakeVoice();
    await run(voice, "Good morning.");
    expect(voice.voicesUsed).toEqual(["en_US-amy-medium"]);
    expect(voice.synthesized).toEqual(["Good morning."]);
  });

  it("uses the Marathi voice for Marathi", async () => {
    const voice = new FakeVoice();
    await run(voice, "आज हवामान चांगले आहे.");
    expect(voice.voicesUsed).toEqual(["mr_IN-google-medium"]);
  });

  it("reads Hindi with the main voice rather than staying silent when the Hindi voice cannot be loaded", async () => {
    const voice = new FakeVoice({ failVoices: ["hi_IN-priyamvada-medium"] });
    await run(voice, "आज मौसम अच्छा है।");
    expect(voice.voicesUsed).toEqual(["en_US-amy-medium"]);
    expect(voice.synthesized).toEqual(["आज मौसम अच्छा है।"]);
  });

  it("uses the main voice for everything when no language voices are set", async () => {
    const voice = new FakeVoice();
    await run(voice, "आज का weather अच्छा है।", {});
    expect(voice.voicesUsed).toEqual(["en_US-amy-medium"]);
  });
});
