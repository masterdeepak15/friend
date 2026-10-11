/** The words Alexa says and the lead-ins its sentences start with, in each language the skill supports. */
export type Lang = "en" | "hi";
export const langOf = (locale: string | undefined): Lang => (locale?.toLowerCase().startsWith("hi") ? "hi" : "en");

/**
 * Open questions: Alexa only passes on what matches a sample sentence, and a free-text slot needs a word before it. So each way to
 * start a sentence is its own intent (the engine puts the start back in front of what was heard): "how", "what", "tell me",
 * "remind me", "send", "explain"... Anything the assistant may do by voice can be asked this way.
 */
const LEADS = [
  ["HowIntent", "how", "कैसे"],
  ["WhatIntent", "what", "क्या"],
  ["TellMeIntent", "tell me", "मुझे बताओ"],
  ["ShowMeIntent", "show me", "मुझे दिखाओ"],
  ["RemindMeIntent", "remind me", "मुझे याद दिलाओ"],
  ["PleaseIntent", "please", "कृपया"],
  ["CanYouIntent", "can you", "क्या तुम"],
  ["CouldYouIntent", "could you", "क्या आप"],
  ["IsThereIntent", "is there", "क्या कोई"],
  ["GiveMeIntent", "give me", "मुझे दो"],
  ["FindIntent", "find", "खोजो"],
  ["SearchIntent", "search for", "ढूँढो"],
  ["CheckIntent", "check", "जाँचो"],
  ["AddIntent", "add", "जोड़ो"],
  ["SetIntent", "set", "सेट करो"],
  ["CreateIntent", "create", "बनाओ"],
  ["WriteIntent", "write", "लिखो"],
  ["ReadIntent", "read", "पढ़ो"],
  ["SendIntent", "send", "भेजो"],
  ["WhenIntent", "when", "कब"],
  ["WhereIntent", "where", "कहाँ"],
  ["WhoIntent", "who", "कौन"],
  ["WhyIntent", "why", "क्यों"],
  ["WhichIntent", "which", "कौन सा"],
  ["ExplainIntent", "explain", "समझाओ"],
  ["SummarizeIntent", "summarize", "सारांश दो"],
  ["CalculateIntent", "calculate", "गणना करो"],
  ["ConvertIntent", "convert", "बदलो"],
  ["TranslateIntent", "translate", "अनुवाद करो"],
  ["ListIntent", "list", "सूची दिखाओ"],
  ["DoIntent", "do", "क्या मैं"],
  ["IsIntent", "is", "क्या यह"],
  ["AreIntent", "are", "क्या ये"],
] as const;
export type LeadIntent = (typeof LEADS)[number][0];
export const LEAD_INTENTS: readonly LeadIntent[] = LEADS.map((l) => l[0]);
export const LEAD_INS = Object.fromEntries(LEADS.map(([name, en, hi]) => [name, { en, hi }])) as Record<LeadIntent, Record<Lang, string>>;

export type SayKey = "notAllowed" | "greet" | "greetAgain" | "help" | "unknown" | "failed" | "working" | "nothing" | "unavailable" | "whatDo" | "busy";
const SAY: Record<SayKey, Record<Lang, string>> = {
  notAllowed: { en: "I do not know this Echo yet. Allow it in Friend, under Plugins, Alexa.", hi: "मैं इस इको को अभी नहीं पहचानता। फ्रेंड में प्लगइन्स, अलेक्सा में इसे अनुमति दीजिए।" },
  greet: { en: "Friend here. Ask me about your portfolio, the weather, your tasks, or anything else.", hi: "फ्रेंड यहाँ है। मुझसे अपने पोर्टफोलियो, मौसम, कामों या कुछ भी पूछिए।" },
  greetAgain: { en: "What would you like to know?", hi: "आप क्या जानना चाहते हैं?" },
  help: { en: "You can ask how my portfolio is doing, what the weather is, what my tasks are, or for the status. You can also say how, what, tell me, or show me, and then your question.", hi: "आप पूछ सकते हैं कि मेरा पोर्टफोलियो कैसा है, मौसम कैसा है, मेरे काम क्या हैं, या स्थिति क्या है। आप कैसे, क्या, मुझे बताओ, या मुझे दिखाओ कहकर अपना सवाल भी पूछ सकते हैं।" },
  unknown: { en: "Sorry, I did not understand that.", hi: "माफ़ कीजिए, मैं यह समझ नहीं पाया।" },
  failed: { en: "Sorry, I could not do that just now.", hi: "माफ़ कीजिए, मैं अभी यह नहीं कर सका।" },
  working: { en: "Still working on it. Ask me if it is ready.", hi: "अभी काम चल रहा है। पूछिए कि क्या तैयार है।" },
  nothing: { en: "There is nothing waiting for you.", hi: "आपके लिए कुछ भी इंतज़ार में नहीं है।" },
  unavailable: { en: "That is not available right now.", hi: "यह अभी उपलब्ध नहीं है।" },
  whatDo: { en: "What do you want to know?", hi: "आप क्या जानना चाहते हैं?" },
  busy: { en: "I am busy with another request. Try again in a moment.", hi: "मैं दूसरे काम में व्यस्त हूँ। थोड़ी देर में फिर कोशिश कीजिए।" },
};
export const say = (lang: Lang, key: SayKey): string => SAY[key][lang];
export const letMeCheck = (lang: Lang): string => (lang === "hi" ? "ठीक है, देखता हूँ।" : "Let me check.");
