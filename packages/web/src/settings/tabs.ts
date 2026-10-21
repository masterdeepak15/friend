export type SettingsTab = "model" | "voice" | "look" | "approvals" | "trading" | "widgets" | "system" | "usage" | "security" | "office";

export const TABS: { id: SettingsTab; label: string; note: string }[] = [
  { id: "model", label: "Model", note: "Where Friend thinks" },
  { id: "voice", label: "Voice", note: "Speaking and listening" },
  { id: "look", label: "Voice presence", note: "How it looks" },
  { id: "approvals", label: "Approvals", note: "How much it asks" },
  { id: "trading", label: "Trading", note: "What Friend may do with money" },
  { id: "widgets", label: "Widgets", note: "Music, clock, quick launch" },
  { id: "system", label: "Startup", note: "Start with the computer, updates" },
  { id: "office", label: "Office", note: "Workers, roles, projects, limits" },
  { id: "usage", label: "Usage", note: "Tokens used, day by day" },
  { id: "security", label: "Security", note: "Password and PIN" },
];
