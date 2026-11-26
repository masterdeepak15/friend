/** Ready-made addresses for services that speak the OpenAI way. Picking one fills the address (and a model to start with); the key is the owner's. */
export interface OpenAiPreset {
  id: string;
  label: string;
  url: string;
  /** A model to start with. Empty: the owner types one (or keeps what is there). */
  model: string;
  /** Where the owner gets a key, or what to do instead. */
  hint: string;
}

export const OPENAI_PRESETS: readonly OpenAiPreset[] = [
  { id: "omniroute", label: "OmniRoute (many providers, including Kiro and Antigravity)", url: "http://localhost:20128/v1", model: "auto", hint: "Run OmniRoute on this PC and sign in to each provider in its dashboard (Kiro and Antigravity sign in there). No key needed here unless you set one in OmniRoute." },
  { id: "xai", label: "Grok (xAI)", url: "https://api.x.ai/v1", model: "grok-4", hint: "Create an API key in the xAI console (console.x.ai)." },
  { id: "gemini", label: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", hint: "Create a free key at aistudio.google.com/apikey. This is Google's own OpenAI-style address for Gemini." },
  { id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/api/v1", model: "openrouter/auto", hint: "Create a key at openrouter.ai/keys. Model names look like provider/model." },
  { id: "nvidia", label: "NVIDIA NIM", url: "https://integrate.api.nvidia.com/v1", model: "meta/llama-3.3-70b-instruct", hint: "Create a key at build.nvidia.com (it starts with nvapi-)." },
  { id: "zai", label: "Z.ai (GLM)", url: "https://api.z.ai/api/paas/v4", model: "glm-4.6", hint: "Create a key in the Z.ai console. On the GLM Coding plan use https://api.z.ai/api/coding/paas/v4 as the address." },
  { id: "opencode-zen", label: "OpenCode Zen", url: "https://opencode.ai/zen/v1", model: "", hint: "Create a key at opencode.ai/zen and type the model name it lists." },
];

/** The preset whose address is this one (a trailing slash does not matter), or null for a custom address. */
export function presetFor(url: string): OpenAiPreset | null {
  const clean = url.trim().replace(/\/+$/, "");
  return OPENAI_PRESETS.find((p) => p.url === clean) ?? null;
}
