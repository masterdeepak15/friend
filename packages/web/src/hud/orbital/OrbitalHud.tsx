import type { HudView, HudWidgetId } from "@friend/protocol";
import { useEffect, useState, type CSSProperties, type KeyboardEvent } from "react";
import { describeStatus } from "../../overlay/StatusBadge";
import type { StageViewState } from "../../store";
import { ZONE_GAP, centreClear, layoutMode, orbitNodes, orbitRadius, zoneRect, type Rect, type ZoneId } from "./geometry";
import { Frame, HexNode, HudDefs, LinkLine, SegmentedRing, type Tone } from "./kit";
import { visibleWidgets, type WidgetDef } from "./registry";
import "./orbital.css";

/** What a click or Enter on the HUD asks to open. */
export type ExpandId = { kind: "widget"; id: HudWidgetId } | { kind: "node"; id: string };
type Launcher = HudView["launcher"][number];

export interface OrbitalHudProps {
  hud: HudView;
  state: StageViewState;
  /** Today's usage as a share of the busiest recent day, 0..100; null while it is not known. */
  usage?: number | null;
  /** The window size; read from the window when left out. */
  viewport?: { w: number; h: number };
  onLaunch: (item: Launcher) => void;
  onExpand: (target: ExpandId) => void;
}

const FRAME: Record<HudWidgetId, "chamfer" | "bracket" | "octagon"> = { system: "chamfer", voice: "bracket", network: "bracket", feed: "chamfer", radar: "chamfer", tickets: "bracket", budget: "bracket", approval: "octagon", usage: "chamfer" };

function useWindowSize(override?: { w: number; h: number }): { w: number; h: number } {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (override) return;
    const on = () => setSize(read());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [override]);
  return override ?? size;
}

/** True while the tab is hidden, so every loop can stop. */
function useHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return hidden;
}

function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

const px = (r: Rect): CSSProperties => ({ position: "absolute", left: r.x, top: r.y, width: r.width, height: r.height });
const activate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

/** The widgets that share a zone split it between them, top to bottom. */
function placeWidgets(list: WidgetDef[], w: number, h: number): Map<HudWidgetId, Rect> {
  const byZone = new Map<ZoneId, WidgetDef[]>();
  for (const def of list) if (def.zone !== "centre") byZone.set(def.zone, [...(byZone.get(def.zone) ?? []), def]);
  const out = new Map<HudWidgetId, Rect>();
  for (const [zone, defs] of byZone) {
    const r = zoneRect(zone, w, h);
    const each = r.height / defs.length;
    defs.forEach((def, i) => out.set(def.id, { x: r.x, y: r.y + i * each, width: r.width, height: each - (defs.length > 1 ? ZONE_GAP / 2 : 0) }));
  }
  return out;
}

function TopBar({ hud, state, rect }: { hud: HudView; state: StageViewState; rect: Rect }) {
  const now = useNow(hud.clock.seconds ? 1000 : 15_000);
  const locale = hud.clock.locale || undefined;
  const time = now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", ...(hud.clock.seconds ? { second: "2-digit" } : {}), hour12: hud.clock.hour12 });
  const date = now.toLocaleDateString(locale, { weekday: "short", day: "2-digit", month: "short" });
  const status = describeStatus({ connection: state.connection, deviceOnline: state.deviceOnline, approval: state.approval, voiceMode: state.voice.mode, busy: state.busy, activity: state.activity });
  return (
    <Frame variant="chamfer" running className="ob-topbar" style={px(rect)} data-testid="orbital-topbar">
      <div className="ob-topbar-row">
        <span className="ob-name">{(state.assistantName || "FRIEND").toUpperCase()} · {hud.terminalLabel}</span>
        <span className="ob-status">{status.text}</span>
        <time className="ob-time">{time} · {date}</time>
      </div>
    </Frame>
  );
}

function UsageLabel({ usage, style, onClick }: { usage: number | null | undefined; style?: CSSProperties; onClick: () => void }) {
  const known = typeof usage === "number" && Number.isFinite(usage);
  return (
    <button type="button" className="ob-usage-label ob-hit" data-widget="usage" style={style} onClick={onClick} aria-label={known ? `Usage ${Math.round(usage)} percent of your busiest day` : "Usage, no data yet"}>
      USAGE {known ? `${Math.round(usage)}%` : "—"}
    </button>
  );
}

/**
 * The orbital screen. It is drawn over the stage: the orb itself (the stage's presence) stays where it is in the clear centre; this
 * layer adds the rings, the orbit of quick-launch nodes and the edge instruments. It only takes the pointer on the nodes and
 * instruments, so a press anywhere else still reaches the stage.
 */
export function OrbitalHud({ hud, state, usage = null, viewport, onLaunch, onExpand }: OrbitalHudProps) {
  const { w, h } = useWindowSize(viewport);
  const hidden = useHidden();
  const mode = layoutMode(w, h);
  const widgets = visibleWidgets(hud.density, hud.widgets, mode, state.approval !== null);
  const pending = state.approval !== null;
  const toneOf = (def: WidgetDef): Tone => (def.id === "approval" ? (pending ? "orange" : "cyan") : def.tone);
  const open = (id: HudWidgetId) => () => onExpand({ kind: "widget", id });
  const frame = (def: WidgetDef, style?: CSSProperties) => (
    <Frame key={def.id} data-widget={def.id} variant={FRAME[def.id]} tone={toneOf(def)} title={def.title} running={def.id === "feed" || (def.id === "approval" && pending)} className="ob-zone ob-hit" style={style} role="button" tabIndex={0} aria-label={def.title} onClick={open(def.id)} onKeyDown={activate(open(def.id))} />
  );
  const root = { className: "orbital", "data-testid": "orbital", "data-mode": mode, "data-hud-anim": hud.animations, ...(hidden ? { "data-paused": "" } : {}) };
  const hasUsage = widgets.some((d) => d.id === "usage");

  if (mode === "compact") {
    return (
      <div {...root}>
        <HudDefs />
        <div className="ob-chips">
          {hud.launcher.map((item) => (
            <button key={item.id} type="button" className="ob-chip ob-hit" onClick={() => onLaunch(item)}>
              <span aria-hidden="true">{item.icon}</span> {item.label}
            </button>
          ))}
        </div>
        <div className="ob-strip ob-hit">
          {widgets.filter((d) => d.zone !== "centre").map((d) => frame(d, { minWidth: 150, height: 64, flex: "none" }))}
          {hasUsage && <UsageLabel usage={usage} onClick={open("usage")} />}
        </div>
      </div>
    );
  }

  const R = orbitRadius(w, h);
  const c = centreClear(w, h);
  const nodes = orbitNodes(hud.launcher.length, w, h);
  const usageR = 0.68 * R;
  const placed = placeWidgets(widgets, w, h);
  return (
    <div {...root}>
      <HudDefs />
      <svg className="ob-scene" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        <g className="ob-spin ob-fast"><circle cx={c.cx} cy={c.cy} r={0.43 * R} className="ob-ring-dash" /></g>
        <g className="ob-spin ob-reverse"><circle cx={c.cx} cy={c.cy} r={0.5 * R} className="ob-ring-long" /></g>
        <circle cx={c.cx} cy={c.cy} r={0.57 * R} className="ob-ring-thin" />
        <circle cx={c.cx} cy={c.cy} r={R} className="ob-orbit" />
        {nodes.map((n, i) => {
          const dir = { x: Math.cos((n.angle * Math.PI) / 180), y: Math.sin((n.angle * Math.PI) / 180) };
          return <LinkLine key={hud.launcher[i]!.id} x1={c.cx + dir.x * 0.45 * R} y1={c.cy + dir.y * 0.45 * R} x2={c.cx + dir.x * (R - 36)} y2={c.cy + dir.y * (R - 36)} />;
        })}
      </svg>
      {hasUsage && (
        <>
          <div className="ob-usage-ring" style={{ left: c.cx - usageR - 14, top: c.cy - usageR - 14, width: 2 * usageR + 28, height: 2 * usageR + 28 }}>
            <SegmentedRing value={usage ?? 0} radius={usageR} size={2 * usageR + 28} />
          </div>
          <UsageLabel usage={usage} style={{ position: "absolute", left: c.cx, top: c.cy + usageR + 30, transform: "translateX(-50%)" }} onClick={open("usage")} />
        </>
      )}
      {nodes.map((n, i) => {
        const item = hud.launcher[i]!;
        return <HexNode key={item.id} x={n.x} y={n.y} label={item.label} glyph={item.icon} onClick={() => onLaunch(item)} />;
      })}
      <TopBar hud={hud} state={state} rect={zoneRect("top", w, h)} />
      {widgets.filter((d) => d.zone !== "centre").map((d) => frame(d, px(placed.get(d.id)!)))}
      <p className="ob-hint" style={{ left: ZONE_GAP, top: zoneRect("bottom", w, h).y, width: w - 2 * ZONE_GAP, height: zoneRect("bottom", w, h).height }}>▸ press and hold to talk · tap to type</p>
    </div>
  );
}
