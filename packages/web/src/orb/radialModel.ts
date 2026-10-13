import type { OwnerMenuProps } from "../overlay/OwnerMenu";
import { NEXT_VIEW } from "../overlay/menuShared";
import { TABS } from "../settings/tabs";

export type IconName =
  | "mic"
  | "hands"
  | "voiceprint"
  | "family"
  | "mute"
  | "screen"
  | "camera"
  | "chat"
  | "calendar"
  | "music"
  | "launch"
  | "eye"
  | "gear"
  | "brain"
  | "speaker"
  | "sparkle"
  | "shield"
  | "chart"
  | "grid"
  | "lock"
  | "plug"
  | "link"
  | "user"
  | "list"
  | "logout"
  | "alert";

export interface OrbItem {
  id: string;
  label: string;
  icon: IconName;
  /** A switch shows whether it is on and the menu stays open after it is used; the others close the menu. */
  kind: "toggle" | "open" | "action";
  on?: boolean;
  danger?: boolean;
  run: () => void;
}

export interface OrbCategory {
  id: string;
  label: string;
  icon: IconName;
  items: OrbItem[];
}

/** What the owner menu does that is not just calling a prop: signing out, locking, and going back to the classic menu. */
export interface OrbHelpers {
  logout: () => void;
  lock: () => void;
  classic: () => void;
}

const TAB_ICON: Record<string, IconName> = { model: "brain", voice: "speaker", look: "sparkle", approvals: "shield", trading: "chart", widgets: "grid", system: "launch", security: "lock" };

/** The rings of the menu, built only from what this Friend can really do right now. A ring with nothing in it is left out. */
export function buildCategories(p: OwnerMenuProps, h: OrbHelpers): OrbCategory[] {
  const out: OrbCategory[] = [];
  const add = (c: OrbCategory) => c.items.length > 0 && out.push(c);

  const voice: OrbItem[] = [];
  if (p.voiceAvailable && p.onToggleHandsFree) voice.push({ id: "voice.handsfree", label: "Hands-free", icon: "hands", kind: "toggle", on: !!p.handsFreeOn, run: p.onToggleHandsFree });
  if (p.voiceAvailable && p.onEnroll) voice.push({ id: "voice.enroll", label: p.voiceEnrolled ? "Voice settings" : "Enroll my voice", icon: "voiceprint", kind: "open", run: p.onEnroll });
  if (p.voiceAvailable && p.voiceEnrolled && p.onHousehold) voice.push({ id: "voice.family", label: "Family voices", icon: "family", kind: "open", run: p.onHousehold });
  voice.push({ id: "voice.mute", label: "Mute stage", icon: "mute", kind: "toggle", on: p.muted, run: p.onToggleMute });
  add({ id: "voice", label: "Voice", icon: "mic", items: voice });

  const screen: OrbItem[] = [];
  const sw = (id: string, label: string, icon: IconName, on: boolean | undefined, run: (() => void) | undefined) => run && screen.push({ id, label, icon, kind: "toggle", on: !!on, run });
  sw("screen.camera", "Camera", "camera", p.cameraOn, p.onToggleCamera);
  sw("screen.chat", "Chat", "chat", p.chatOn, p.onToggleChat);
  sw("screen.tasks", "Schedule", "calendar", p.tasksOn, p.onToggleTasks);
  sw("screen.music", "Music", "music", p.musicOn, p.onToggleMusic);
  sw("screen.launcher", "Quick launch", "launch", p.launcherOn, p.onToggleLauncher);
  if (p.view && p.onView) {
    const { view, onView } = p;
    screen.push({ id: "screen.view", label: `View: ${view}`, icon: "eye", kind: "action", run: () => onView(NEXT_VIEW[view]) });
  }
  add({ id: "screen", label: "Screen", icon: "screen", items: screen });

  if (p.onSettings) {
    const open = p.onSettings;
    add({ id: "settings", label: "Settings", icon: "gear", items: TABS.map((t) => ({ id: `settings.${t.id}`, label: t.label, icon: TAB_ICON[t.id] ?? "gear", kind: "open" as const, run: () => open(t.id) })) });
  }

  const connect: OrbItem[] = [];
  if (p.onPlugins) connect.push({ id: "connect.plugins", label: "Plugins", icon: "plug", kind: "open", run: p.onPlugins });
  if (p.onConnectors) connect.push({ id: "connect.connectors", label: "Connectors", icon: "link", kind: "open", run: p.onConnectors });
  add({ id: "connect", label: "Connect", icon: "plug", items: connect });

  add({
    id: "account",
    label: "Account",
    icon: "user",
    items: [
      { id: "account.classic", label: "Classic menu", icon: "list", kind: "action", run: h.classic },
      { id: "account.logout", label: "Log out", icon: "logout", kind: "action", run: h.logout },
      { id: "account.lock", label: "Emergency lock", icon: "alert", kind: "action", danger: true, run: h.lock },
    ],
  });
  return out;
}

// ---------------------------------------------------------------- geometry (degrees clockwise from the top)

export const polar = (cx: number, cy: number, r: number, deg: number): { x: number; y: number } => {
  const a = (deg * Math.PI) / 180;
  return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) };
};

export interface ArcSpan {
  start: number;
  end: number;
  mid: number;
}

/** A full ring of `n` equal arcs with a small gap between them, the first one centred on the top. */
export function layoutArcs(n: number, gap = 4): ArcSpan[] {
  const step = 360 / n;
  return Array.from({ length: n }, (_, i) => {
    const mid = i * step;
    return { start: mid - step / 2 + gap / 2, end: mid + step / 2 - gap / 2, mid };
  });
}

/** `n` smaller arcs fanned out around the middle of their parent. They never wrap all the way round. */
export function fan(parentMid: number, n: number, gap = 3, size = 36, maxSpan = 330): ArcSpan[] {
  const each = Math.min(size, (maxSpan - (n - 1) * gap) / n);
  const total = n * each + (n - 1) * gap;
  const first = parentMid - total / 2;
  return Array.from({ length: n }, (_, i) => {
    const start = first + i * (each + gap);
    return { start, end: start + each, mid: start + each / 2 };
  });
}

/** The outline of a ring segment: the outer edge from `a0` to `a1`, then back along the inner edge. */
export function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const large = a1 - a0 > 180 ? 1 : 0;
  const f = (n: number) => Number(n.toFixed(2));
  const p = (r: number, a: number) => {
    const { x, y } = polar(cx, cy, r, a);
    return `${f(x)} ${f(y)}`;
  };
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

// ---------------------------------------------------------------- what is open

export interface MenuState {
  open: boolean;
  /** The ring whose second row of arcs is showing. */
  category: string | null;
  /** The arc under the pointer or focus. */
  hover: string | null;
}

export type MenuAction = { type: "open" } | { type: "close" } | { type: "toggle" } | { type: "back" } | { type: "escape" } | { type: "category"; id: string } | { type: "hover"; id: string | null };

const CLOSED: MenuState = { open: false, category: null, hover: null };

export function menuReducer(s: MenuState, a: MenuAction): MenuState {
  switch (a.type) {
    case "open":
      return { open: true, category: null, hover: null };
    case "close":
      return CLOSED;
    case "toggle":
      return s.open ? CLOSED : { open: true, category: null, hover: null };
    case "escape": // closed: open it; open: step back one level, then close
      return s.open ? menuReducer(s, { type: "back" }) : { open: true, category: null, hover: null };
    case "back":
      return s.category ? { ...s, category: null, hover: null } : CLOSED;
    case "category":
      return s.open ? { ...s, category: s.category === a.id ? null : a.id, hover: null } : s;
    case "hover":
      return s.open ? { ...s, hover: a.id } : s;
  }
}

/** The words in the middle of the orb. */
export function caption(s: MenuState, cats: OrbCategory[], voiceMode: string, busy: boolean): string {
  if (s.open) {
    if (!s.hover) return (s.category && cats.find((c) => c.id === s.category)?.label.toUpperCase()) || "SELECT";
    const cat = cats.find((c) => c.id === s.hover);
    const item = cats.flatMap((c) => c.items).find((i) => i.id === s.hover);
    return (cat?.label ?? item?.label ?? "SELECT").toUpperCase();
  }
  if (voiceMode === "listening") return "LISTENING";
  if (busy || voiceMode === "transcribing" || voiceMode === "speaking") return "BUSY";
  return "MARK II";
}
