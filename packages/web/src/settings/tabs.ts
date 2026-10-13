export type SettingsTab = "model" | "voice" | "look" | "approvals" | "trading" | "widgets" | "security";

export const TABS: { id: SettingsTab; label: string; note: string }[] = [
  { id: "model", label: "Model", note: "Where Friend thinks" },
  { id: "voice", label: "Voice", note: "Speaking and listening" },
  { id: "look", label: "Voice presence", note: "How it looks" },
  { id: "approvals", label: "Approvals", note: "How much it asks" },
  { id: "trading", label: "Trading", note: "What Friend may do with money" },
  { id: "widgets", label: "Widgets", note: "Music, clock, quick launch" },
  { id: "security", label: "Security", note: "Password and PIN" },
];
