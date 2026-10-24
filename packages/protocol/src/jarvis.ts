/**
 * The Jarvis UI components (the HUD library the screen already looks like) that the assistant may draw with. The assistant sends a plain tree
 * of data, never code: each node names a component from this table and gives only the props listed for it. The screen checks the tree again
 * before it draws it, so a tree that does not pass here is never drawn.
 */
export interface JarvisNode {
  /** The component: a name from JARVIS_COMPONENTS, or Row, Column, Grid. */
  c: string;
  /** Its props: plain data, only the names listed for the component. */
  p?: Record<string, unknown>;
  /** What is inside it: more nodes, or text. */
  kids?: (JarvisNode | string)[];
  /** Content for the other places a component keeps parts (a card's header and footer): slot name -> parts. */
  slots?: Record<string, (JarvisNode | string)[]>;
}

export const JARVIS_LIMITS = { depth: 6, nodes: 120, text: 2000, items: 200 } as const;

/** Component name -> the props it accepts and what the assistant should know about it. */
export const JARVIS_COMPONENTS: Record<string, { props: string[]; note?: string; kids?: boolean; slots?: string[] }> = {
  Row: { props: ["gap", "wrap"], kids: true, note: "puts its parts side by side" },
  Column: { props: ["gap"], kids: true, note: "stacks its parts" },
  Grid: { props: ["columns", "gap"], kids: true, note: "a grid with this many columns" },
  JCard: { props: ["cardStyle", "color", "padding"], kids: true, slots: ["header", "footer"], note: "a card around its parts; cardStyle CornerBracket|Notched|SideRail|GlowBorder" },
  JHudFrame: { props: ["color", "systemLabel", "showTop", "showBottom", "showDots", "showLive", "showWaveform", "showTicks", "showRec"], kids: true, slots: ["topContent", "bottomContent"], note: "a HUD frame with bars around its parts" },
  JHudFrameCard: { props: ["frameStyle", "color", "title", "showStatusDot", "width", "height"], kids: true, note: "a titled frame card around its parts" },
  JHudBar: { props: ["position", "color", "animSpeed", "systemLabel", "showDots", "showWaveform", "showTicks", "showLive", "showRec", "tickCount", "tickActive"], kids: true, note: "a top or bottom HUD bar" },
  JTabs: { props: ["color"], kids: true, note: "tabs; put JTab parts inside it" },
  JTab: { props: ["tabKey", "label", "icon", "badge", "disabled"], kids: true, note: "one tab and its panel (inside JTabs); tabKey is unique in its JTabs" },
  JAccordion: { props: ["title", "icon", "badge", "defaultOpen", "state", "color"], kids: true, note: "a section that opens and closes" },
  JFormField: { props: ["label", "error", "hint", "required"], kids: true, note: "a label, hint and error around a field" },
  JButton: { props: ["shape", "color", "size", "variant", "loading", "disabled"], kids: true, note: "a button as a picture: it does nothing when pressed" },
  JInput: { props: ["type", "defaultValue", "placeholder", "disabled", "readOnly", "error", "color", "size"], note: "a text field as a picture (defaultValue shows text in it)" },
  JTextArea: { props: ["defaultValue", "placeholder", "disabled", "readOnly", "error", "rows", "color", "size"], note: "a text area as a picture" },
  JSelect: { props: ["options", "defaultValue", "placeholder", "disabled", "color", "size"], note: "options [{value, label}]" },
  JToggle: { props: ["defaultChecked", "label", "disabled", "color"], note: "a switch" },
  JCheckbox: { props: ["defaultChecked", "label", "disabled", "color"], note: "a checkbox" },
  JSlider: { props: ["defaultValue", "min", "max", "step", "showValue", "disabled", "color"], note: "a slider" },
  JSpinner: { props: ["size", "color", "label", "showLabel"], note: "a loading arc" },
  JOrb: { props: ["systemName", "size", "color", "state", "listening"], note: "a pulsing orb" },
  JDonutChart: { props: ["data", "size", "thickness", "centerValue", "centerLabel", "showLegend"], note: "data [{label, value, color?}]; size like 200px" },
  JRadarChart: { props: ["axes", "size", "rings", "showLabels"], note: "axes [{label, value}]; size like 240px" },
  JStatCard: { props: ["title", "value", "state", "sub", "showStatusDot", "badge", "badgeColor", "barValue", "dataRows", "color"], note: "value is a string; dataRows [{label, value}]; barValue 0-100" },
  JProgress: { props: ["value", "label", "state", "variant", "indeterminate", "showPercent", "total"], note: "value 0-100; variant bar|ticks" },
  JGaugeChart: { props: ["value", "min", "max", "size", "thickness", "label", "displayValue", "showNeedle", "showTicks", "showMinMax", "ticks"], note: "a radial gauge; size like 200px" },
  JBarChart: { props: ["data", "height", "orientation", "showGrid", "showAxisLabels", "showValues"], note: "data [{label, value}]; height like 220px" },
  JLineChart: { props: ["data", "height", "showArea", "showDots", "showAxisLabels", "showGrid", "gridLines"], note: "data [{label, value}]; height like 200px" },
  JSparkline: { props: ["data", "showArea", "showTrend", "height", "width"], note: "data is a list of numbers; height and width like 40px" },
  JTable: { props: ["columns", "rows", "stateColumn", "showFooter", "footerLabel"], note: "columns [{key, label}]; rows [{key: value}]" },
  JBadge: { props: ["color", "size", "shape", "blink", "showDot"], kids: true, note: "a small label; its text is the kids" },
  JStatusPill: { props: ["state", "blink"], kids: true, note: "a status dot and its text (the kids); state active|warning|error|success" },
  JAlert: { props: ["state", "title", "blink"], kids: true, note: "a banner; its text is the kids" },
  JDataRow: { props: ["label", "value", "barPercent", "state"], note: "a key, its value and an optional bar 0-100" },
  JHudLabel: { props: ["variant", "text", "subText", "value", "color", "showDot", "showLine"], note: "a labelled value; variant chip|arc|metric" },
  JArcMeter: { props: ["level", "totalArcs", "color", "orientation", "showLabel", "label", "showValue"], note: "a segmented level meter" },
  JArcReactor: { props: ["level", "size", "color", "label", "animated"], note: "level 0-100" },
  JHeatmap: { props: ["data", "color", "cellSize", "gap", "showValue", "title"], note: "data is rows of [{value}]" },
  JActivityFeed: { props: ["items", "maxRows", "showTime", "showSource"], note: "items [{id, time?, level?, message, source?}] oldest first" },
  JKPITicker: { props: ["items", "speed", "color", "height"], note: "items [{label, value, delta?, trend?}]" },
  JHudClock: { props: ["analog", "color", "size", "showDate"], note: "a clock" },
  JWaveform: { props: ["barCount", "color", "height", "active"], note: "animated sound bars" },
  JDivider: { props: ["orientation", "label", "showDot"], note: "a line, with a label if given; orientation horizontal|vertical" },
  JNodeGraph: { props: ["nodes", "edges", "height", "title", "showLegend"], note: "nodes [{id, label, x, y, type?, color?, sub?, value?, pulse?}], edges [{from, to, color?, style?, arrow?, animated?}]; x and y in pixels" },
};

/** The names of the components that are object types of their own (Row, Column and Grid only lay parts out inside one). */
export const JARVIS_TYPES: string[] = Object.keys(JARVIS_COMPONENTS).filter((n) => !["Row", "Column", "Grid"].includes(n));
export const isJarvisType = (type: string): boolean => JARVIS_TYPES.includes(type);

/** What an object of a Jarvis type draws: the component named by its type, with the rest of its props, and kids and slots for the parts inside. */
export function jarvisTreeOf(type: string, props: Record<string, unknown>): JarvisNode {
  const { kids, slots, ...p } = props;
  return { c: type, p, ...(Array.isArray(kids) ? { kids: kids as JarvisNode["kids"] } : {}), ...(slots && typeof slots === "object" ? { slots: slots as JarvisNode["slots"] } : {}) };
}

/** Props that are never accepted, whatever the component: they could run code, or restyle or break out of the screen. */
const NEVER = /^(on[A-Z]|dangerously|style$|className$|ref$|key$|children$|href$|src$)/;

const plain = (v: unknown, depth = 0): string | null => {
  if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return null;
  if (typeof v === "string") return v.length > JARVIS_LIMITS.text ? "A text is too long." : null;
  if (depth > 4) return "A prop is nested too deep.";
  if (Array.isArray(v)) {
    if (v.length > JARVIS_LIMITS.items) return "A list is too long.";
    for (const x of v) {
      const bad = plain(x, depth + 1);
      if (bad) return bad;
    }
    return null;
  }
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (NEVER.test(k)) return `A prop may not have the key ${k}.`;
      const bad = plain(x, depth + 1);
      if (bad) return bad;
    }
    return null;
  }
  return "Props must be plain data (text, numbers, true or false, lists and objects).";
};

/** Checks the props of a jarvis object ({ title?, ui }) and says what is wrong in a sentence for the assistant, or null when it can be drawn. */
export function jarvisProblem(props: unknown): string | null {
  const ui = props && typeof props === "object" ? (props as { ui?: unknown }).ui : undefined;
  if (!ui || typeof ui !== "object") return "A jarvis object needs ui: a tree like {c: \"JStatCard\", p: {...}, kids: [...]}, where c is the component name.";
  let count = 0;
  const walk = (n: unknown, depth: number): string | null => {
    if (typeof n === "string") return n.length > JARVIS_LIMITS.text ? "A text is too long." : null;
    if (!n || typeof n !== "object" || typeof (n as JarvisNode).c !== "string") return "Every node needs c, the component name.";
    if (depth > JARVIS_LIMITS.depth) return `The tree is too deep (at most ${JARVIS_LIMITS.depth} levels).`;
    if (++count > JARVIS_LIMITS.nodes) return `The tree has too many parts (at most ${JARVIS_LIMITS.nodes}).`;
    const node = n as JarvisNode;
    const def = JARVIS_COMPONENTS[node.c];
    if (!def) return `${node.c} is not available. Use one of: ${Object.keys(JARVIS_COMPONENTS).join(", ")}.`;
    for (const k of Object.keys(node.p ?? {})) {
      if (NEVER.test(k)) return `${node.c}: the prop ${k} is not allowed.`;
      if (!def.props.includes(k)) return `${node.c} has no prop ${k}. Its props: ${def.props.join(", ") || "none"}.`;
    }
    const bad = plain(node.p ?? {});
    if (bad) return `${node.c}: ${bad}`;
    for (const slot of Object.keys(node.slots ?? {})) {
      if (!def.slots?.includes(slot)) return `${node.c} has no slot ${slot}.${def.slots ? ` Its slots: ${def.slots.join(", ")}.` : ""}`;
      const parts = node.slots![slot];
      if (!Array.isArray(parts)) return `${node.c}: the slot ${slot} must be a list.`;
      for (const part of parts) {
        const r = walk(part, depth + 1);
        if (r) return r;
      }
    }
    if (node.kids !== undefined && !Array.isArray(node.kids)) return `${node.c}: kids must be a list.`;
    if (node.kids && !def.kids && node.kids.some((k) => typeof k !== "string")) return `${node.c} cannot contain other components.`;
    for (const k of node.kids ?? []) {
      const r = walk(k, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(ui, 1);
}

/** Checks an object of a Jarvis type (its type is the component): a sentence for the assistant when it is wrong, null when it can be drawn. */
export function jarvisObjectProblem(type: string, props: Record<string, unknown>): string | null {
  return jarvisProblem({ ui: jarvisTreeOf(type, props) });
}

/** The list the assistant is given: each component, its props, how big it needs to be and what it is for. */
export function jarvisCatalog(): string {
  return Object.entries(JARVIS_COMPONENTS)
    .map(([name, d]) => `${name}${d.props.length ? ` {${d.props.join(", ")}}` : ""}${d.kids ? " [kids]" : ""}${d.slots ? ` [slots: ${d.slots.join(", ")}]` : ""}${LEAF[name] ? ` (about ${jarvisNaturalSize({ c: name }).w}x${jarvisNaturalSize({ c: name }).h} px)` : ""}${d.note ? `: ${d.note}` : ""}`)
    .join("\n");
}
// ---- how big a drawing needs to be ----

type Size = { w: number; h: number };
const px = (v: unknown, d: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : d;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const GAP = 8;

/** Text as a part: about this wide and this tall. */
const textSize = (s: string): Size => ({ w: Math.min(360, Math.max(40, s.length * 8)), h: 22 * Math.max(1, Math.ceil((s.length * 8) / 360)) });

/** What each leaf component needs, from what it is given (the sizes the library draws them at). */
const LEAF: Record<string, (p: Record<string, unknown>) => Size> = {
  JStatCard: (p) => ({ w: 260, h: 112 + (typeof p.barValue === "number" ? 16 : 0) + 28 * arr(p.dataRows).length }),
  JProgress: () => ({ w: 260, h: 50 }),
  JGaugeChart: (p) => ({ w: px(p.size, 190) + 40, h: Math.round(px(p.size, 190) * 0.8) + 50 }),
  JBarChart: (p) => ({ w: 340, h: px(p.height, 220) + 30 }),
  JLineChart: (p) => ({ w: 340, h: px(p.height, 200) + 30 }),
  JSparkline: (p) => ({ w: px(p.width, 200), h: px(p.height, 40) + 16 }),
  JTable: (p) => ({ w: Math.max(300, 120 * arr(p.columns).length), h: 64 + 32 * arr(p.rows).length + (p.showFooter === false ? 0 : 28) }),
  JBadge: () => ({ w: 96, h: 30 }),
  JStatusPill: () => ({ w: 170, h: 40 }),
  JAlert: () => ({ w: 320, h: 76 }),
  JDataRow: () => ({ w: 260, h: 30 }),
  JHudLabel: () => ({ w: 200, h: 52 }),
  JArcMeter: () => ({ w: 200, h: 64 }),
  JArcReactor: (p) => ({ w: px(p.size, 120) + 40, h: px(p.size, 120) + 56 }),
  JHeatmap: (p) => {
    const rows = arr(p.data);
    const cols = Math.max(1, ...rows.map((r) => arr(r).length));
    const step = px(p.cellSize, 28) + px(p.gap, 3);
    return { w: cols * step + 40, h: rows.length * step + 64 };
  },
  JActivityFeed: (p) => ({ w: 360, h: px(p.maxRows, 8) * 28 + 40 }),
  JKPITicker: () => ({ w: 520, h: 40 }),
  JHudClock: (p) => ({ w: px(p.size, 120) + 40, h: px(p.size, 120) + 70 }),
  JWaveform: (p) => ({ w: 200, h: px(p.height, 40) + 20 }),
  JDivider: () => ({ w: 200, h: 24 }),
  JNodeGraph: (p) => ({ w: 560, h: px(p.height, 400) }),
  JOrb: () => ({ w: 140, h: 160 }),
  JSpinner: () => ({ w: 90, h: 90 }),
  JDonutChart: (p) => ({ w: px(p.size, 200) + 40, h: px(p.size, 200) + 40 + (p.showLegend === false ? 0 : 40) }),
  JRadarChart: (p) => ({ w: px(p.size, 240) + 40, h: px(p.size, 240) + 40 }),
  JButton: () => ({ w: 150, h: 46 }),
  JInput: () => ({ w: 260, h: 48 }),
  JTextArea: (p) => ({ w: 300, h: px(p.rows, 3) * 24 + 40 }),
  JSelect: () => ({ w: 220, h: 48 }),
  JToggle: () => ({ w: 200, h: 36 }),
  JCheckbox: () => ({ w: 200, h: 36 }),
  JSlider: () => ({ w: 260, h: 48 }),
  JHudBar: () => ({ w: 600, h: 44 }),
};

/** What a container adds around its parts: [width, height] on top of them. */
const AROUND: Record<string, [number, number]> = { JCard: [28, 28], JHudFrame: [40, 72], JHudFrameCard: [32, 56], JFormField: [0, 34], JAccordion: [28, 52], JTabs: [28, 52], JTab: [0, 0] };

/** How big, in pixels, a drawing needs to be to show everything in it well (the box the assistant should give it). */
export function jarvisNaturalSize(node: JarvisNode | string): Size {
  if (typeof node === "string") return textSize(node);
  const p = node.p ?? {};
  const parts = (node.kids ?? []).map((k) => jarvisNaturalSize(k));
  const slotParts = Object.values(node.slots ?? {}).flat().map((k) => jarvisNaturalSize(k));
  const gap = typeof p.gap === "number" && Number.isFinite(p.gap) ? Math.min(32, Math.max(0, p.gap)) : GAP; // 0 is a real gap
  if (node.c === "Row") return { w: parts.reduce((s, x) => s + x.w, 0) + gap * Math.max(0, parts.length - 1), h: Math.max(0, ...parts.map((x) => x.h)) };
  if (node.c === "Column") return { w: Math.max(0, ...parts.map((x) => x.w)), h: parts.reduce((s, x) => s + x.h, 0) + gap * Math.max(0, parts.length - 1) };
  if (node.c === "Grid") {
    const cols = Math.min(6, Math.max(1, Math.round(px(p.columns, 2))));
    const w = Math.max(0, ...parts.map((x) => x.w));
    const rows = Math.ceil(parts.length / cols);
    const h = Math.max(0, ...parts.map((x) => x.h));
    return { w: w * Math.min(cols, Math.max(1, parts.length)) + gap * (Math.min(cols, Math.max(1, parts.length)) - 1), h: h * rows + gap * Math.max(0, rows - 1) };
  }
  const leaf = LEAF[node.c];
  if (leaf) return leaf(p);
  const around = AROUND[node.c];
  if (around) {
    const inner = { w: Math.max(0, ...parts.map((x) => x.w), ...slotParts.map((x) => x.w)), h: parts.reduce((s, x) => s + x.h, 0) + slotParts.reduce((s, x) => s + x.h, 0) + (slotParts.length ? 12 : 0) };
    return { w: Math.max(160, inner.w + around[0]), h: Math.max(60, inner.h + around[1]) };
  }
  return { w: 200, h: 80 };
}