/** Ready-made connectors the owner can add with one click, each with the steps that have to be done outside Friend first. */
export interface Preset {
  id: string;
  name: string;
  description: string;
  /** What gets saved when the owner adds it (they can still change the fields). */
  connector: { id: string; name: string; kind: "stdio"; command: string; args: string[] };
  /** Done by the owner outside Friend, in this order, before or after adding. */
  setup: string[];
  /** Shown above the Add button. */
  warning?: string;
  /** One click: no form, the fixed command, and Friend checks what it needs first. */
  quick?: boolean;
}

export const PRESETS: Preset[] = [
  {
    id: "chrome",
    name: "Chrome control",
    description: "Lets Friend open pages, read them, click and type in your own Chrome, through your chrome-control extension.",
    quick: true,
    connector: { id: "chrome", name: "Chrome control", kind: "stdio", command: "npx", args: ["-y", "chrome-control-mcp"] },
    setup: [
      "Press Connect. Friend checks that Chrome control is installed and, if it is, adds it for you: it runs npx -y chrome-control-mcp, the same as claude mcp add chrome-control -- npx -y chrome-control-mcp.",
      "If it is not installed yet, Friend says so and can install it for you in the background (npx -y chrome-control-mcp setup).",
      "The one step nobody can do for you, because Chrome does not allow silent installs: load the extension in chrome://extensions (Developer mode, Load unpacked) and switch it on.",
    ],
    warning: "While the extension is on, Friend can act as you on any site it allows. Every action still asks for your approval; in the extension's popup you can limit it to certain sites.",
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Lets Friend search, read and write your email.",
    connector: { id: "gmail", name: "Gmail", kind: "stdio", command: "npx", args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"] },
    setup: [
      "In Google Cloud Console create an OAuth client of type Desktop app for the Gmail API and download its JSON file.",
      "Save it as gcp-oauth.keys.json in a folder called .gmail-mcp inside your user folder (see the README of @gongrzhe/server-gmail-autoauth-mcp).",
      "In a terminal run: npx -y @gongrzhe/server-gmail-autoauth-mcp auth. Your browser shows Google's own sign-in page; Friend never sees your password.",
      "Add the connector here and approve with your PIN.",
    ],
    warning:
      "This is a community-made server, not made by Google. It can read, send and delete mail. Every action asks for your approval, and text inside emails is treated as data that cannot give Friend orders. Only approve a send you recognise.",
  },
];
