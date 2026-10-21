/** The languages the skill package can be made for (Alexa custom skills do not support Marathi). */
export const ALEXA_LOCALES = ["en-IN", "hi-IN"] as const;
export type AlexaLocale = (typeof ALEXA_LOCALES)[number];

/** What each Alexa setting may be set to: the lowest, the highest, and the default. The highest answer time is below Alexa's own 8-second limit. */
export const ALEXA_LIMITS = {
  answerSeconds: { min: 2, max: 7.5, def: 6.5 },
  holdMinutes: { min: 1, max: 60, def: 10 },
  permissionSeconds: { min: 30, max: 600, def: 120 },
  requestsPerMinute: { min: 10, max: 600, def: 60 },
  maxDevices: { min: 1, max: 50, def: 10 },
} as const;

/** A tool name as the registry writes it. */
export const TOOL_NAME = /^[a-z][a-z0-9._-]{1,60}$/;

/** Never reachable by a voice from a speaker device, whatever its tier or the owner's settings: the PC, files, settings, add-ons, the camera and screen. This is a safety floor, not a setting. */
export const NOT_BY_VOICE = ["shell.", "fs.", "code.", "settings.", "connectors.", "plugins.", "plugin.", "integrations.", "camera.", "screen.", "mcp.", "office.", "message.send_file"];
export const isNeverByVoice = (tool: string): boolean => NOT_BY_VOICE.some((p) => tool.startsWith(p));
