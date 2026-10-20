import type { ClientMsg, HudView, HudWidgetId } from "@friend/protocol";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { describeStatus } from "../../overlay/StatusBadge";
import type { UsageApi } from "../../settings/UsageTab";
import type { StageViewState } from "../../store";
import { ExpandedView } from "./ExpandedView";
import { ZONE_GAP, centreClear, layoutMode, orbitNodes, orbitRadius, zoneRect, type Rect, type ZoneId } from "./geometry";
import { Frame, HexNode, HudDefs, LinkLine, SegmentedRing, type Tone } from "./kit";
import { visibleWidgets, type WidgetDef } from "./registry";
import { Safe } from "./Safe";
import { useWindowSize } from "./useWindowSize";
import { ApprovalWidget } from "./widgets/ApprovalWidget";
import { BudgetWidget } from "./widgets/BudgetWidget";
import { FeedWidget } from "./widgets/FeedWidget";
import { NetworkWidget } from "./widgets/NetworkWidget";
import { RadarWidget } from "./widgets/RadarWidget";
import { SystemWidget } from "./widgets/SystemWidget";
import { TicketsWidget } from "./widgets/TicketsWidget";
import { VoiceWidget } from "./widgets/VoiceWidget";
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
  /** Where the usage detail comes from when the usage instrument is opened (the real one by default). */
  usageApi?: UsageApi;
  /** Sends the owner's answer to an approval. */
  send?: (m: ClientMsg) => void;
  onLaunch: (item: Launcher) => void;
  onExpand: (target: ExpandId) => void;
}

const FRAME: Record<HudWidgetId, "chamfer" | "bracket" | "octagon"> = { system: "bracket", voice: "bracket", network: "bracket", feed: "chamfer", radar: "bracket", tickets: "bracket", budget: "bracket", approval: "octagon", usage: "chamfer" };

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

const statusText = (state: StageViewState): string => describeStatus({ connection: state.connection, deviceOnline: state.deviceOnline, approval: state.approval, voiceMode: state.voice.mode, busy: state.busy, activity: state.activity }).text;

function TopBar({ hud, state, rect }: { hud: HudView; state: StageViewState; rect: Rect }) {
  const now = useNow(hud.clock.seconds ? 1000 : 15_000);
  const locale = hud.clock.locale || undefined;
  const time = now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", ...(hud.clock.seconds ? { second: "2-digit" } : {}), hour12: hud.clock.hour12 });
  const date = now.toLocaleDateString(locale, { weekday: "short", day: "2-digit", month: "short" });
  // the line is a notched path with a light running along it, as in the approved mockup
  const line = "M0 34 H330 L360 8 H640 L670 34 H1000";
  return (
    <div className="ob-topbar" data-testid="orbital-topbar" style={px(rect)}>
      <svg className="ob-topbar-line" viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">
        <path className="ob-topbar-base" d={line} />
        <path className="ob-topbar-run" d={line} pathLength={100} />
      </svg>
      <div className="ob-topbar-row">
        <span className="ob-topbar-left">
          <b>{(state.assistantName || "FRIEND").toUpperCase()} · {hud.terminalLabel}</b>
          <small>{statusText(state)}</small>
        </span>
        <span className="ob-title">F R I E N D</span>
        <time className="ob-time">{time} · {date}</time>
      </div>
    </div>
  );
}
function UsageLabel({ usage, style, onClick }: { usage: number | null | undefined; style?: CSSProperties; onClick: () => void }) {
  const known = typeof usage === "number" && Number.isFinite(usage);
  return (
    <button type="button" className="ob-usage-label ob-hit" data-widget="usage" title="Today's usage compared with your busiest day of the last 30" style={style} onClick={onClick} aria-label={known ? `Usage ${Math.round(usage)} percent of your busiest day` : "Usage, no data yet"}>
      USAGE {known ? `${Math.round(usage)}%` : "—"}
    </button>
  );
}

/**
 * The orbital screen. It is drawn over the stage: the orb itself (the stage's presence) stays where it is in the clear centre; this
 * layer adds the rings, the orbit of quick-launch nodes and the edge instruments. It only takes the pointer on the nodes and
 * instruments, so a press anywhere else still reaches the stage.
 */
export function OrbitalHud({ hud, state, usage = null, viewport, usageApi, send = () => {}, onLaunch, onExpand }: OrbitalHudProps) {
  const { w, h } = useWindowSize(viewport);
  const hidden = useHidden();
  const mode = layoutMode(w, h);
  const widgets = visibleWidgets(hud.density, hud.widgets, mode, state.approval !== null);
  const pending = state.approval !== null;
  const toneOf = (def: WidgetDef): Tone => (def.id === "approval" ? (pending ? "orange" : "cyan") : def.tone);
  // One instrument can be open, large, in the middle; Esc, a press outside or the close mark shuts it and the focus goes back to where it was.
  const [expanded, setExpanded] = useState<HudWidgetId | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    setExpanded(null);
    opener.current?.focus();
    opener.current = null;
  }, []);
  const open = (id: HudWidgetId) => () => {
    if (expanded === null) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setExpanded(id);
    onExpand({ kind: "widget", id });
  };
  useEffect(() => {
    if (expanded === null || pending) return;
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation(); // the Esc that closes this must not also open the owner menu
      close();
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [expanded, pending, close]);
  const openW = mode === "compact" ? w - 16 : Math.max(280, Math.min(760, w * 0.62));
  const expandedRect: Rect = { x: (w - openW) / 2, y: h * 0.14, width: openW, height: Math.max(220, Math.min(560, h * 0.7)) };
  // a waiting approval comes first: any open instrument closes, and the approval is drawn as a dialog in the middle (big enough for the PIN pad, full width on a phone)
  const shownExpanded = pending ? null : expanded;
  const expandedEl = shownExpanded && (
    <>
      <div className="ob-backdrop ob-hit" onPointerDown={(e) => { e.stopPropagation(); close(); }} />
      <Safe>
        <ExpandedView id={shownExpanded} state={state} rect={expandedRect} {...(usageApi ? { usageApi } : {})} onClose={close} />
      </Safe>
    </>
  );
  const modalW = mode === "compact" ? w - 16 : Math.max(340, Math.min(480, w * 0.34));
  const modalH = Math.min(h - 16, Math.max(300, Math.min(520, h * 0.7)));
  const modalRect: Rect = { x: (w - modalW) / 2, y: (h - modalH) / 2, width: modalW, height: modalH };
  const edge = (d: WidgetDef) => d.zone !== "centre" && !(d.id === "approval" && pending);
  const content = (id: HudWidgetId) => {
    switch (id) {
      case "system":
        return <SystemWidget stats={state.stats} />;
      case "network":
        return <NetworkWidget stats={state.stats} />;
      case "radar":
        return <RadarWidget deviceOnline={state.deviceOnline} voiceAvailable={state.voice.available} />;
      case "voice":
        return <VoiceWidget level={state.voice.level} mode={state.voice.mode} />;
      case "feed":
        return <FeedWidget lines={state.chat} activity={state.activity} busy={state.busy} />;
      case "tickets":
        return <TicketsWidget />;
      case "budget":
        return <BudgetWidget />;
      default:
        return null;
    }
  };
  const frameInner = (def: WidgetDef, style?: CSSProperties, extra = "") =>
    def.id === "approval" ? (
      // an approval is answered right here, so it is not a click-to-expand button
      <Frame key={def.id} data-widget="approval" variant={pending ? "octagon" : "bracket"} tone={toneOf(def)} title={def.title} running={pending} className={`ob-zone ob-hit ob-static ${extra}`.trim()} style={style}>
        <ApprovalWidget approval={state.approval} send={send} />
      </Frame>
    ) : (
      <Frame key={def.id} data-widget={def.id} variant={FRAME[def.id]} tone={toneOf(def)} title={def.title} running={def.id === "feed"} className="ob-zone ob-hit" style={style} role="button" tabIndex={0} aria-label={def.title} onClick={open(def.id)} onKeyDown={activate(open(def.id))}>
        {content(def.id)}
      </Frame>
    );
  const frame = (def: WidgetDef, style?: CSSProperties, extra = "") => <Safe key={def.id}>{frameInner(def, style, extra)}</Safe>;
  const approvalDef = widgets.find((d) => d.id === "approval");
  const modalEl = pending && approvalDef && (
    <>
      <div className="ob-backdrop ob-modal-backdrop" />
      {frame(approvalDef, px(modalRect), "ob-modal")}
    </>
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
        <p className="ob-compact-status">{statusText(state)}</p>
        <div className="ob-strip">
          {widgets.filter(edge).map((d) => frame(d, { minWidth: 170, height: 100, flex: "none" }))}
          {hasUsage && <UsageLabel usage={usage} onClick={open("usage")} />}
        </div>
        {expandedEl}
        {modalEl}
      </div>
    );
  }

  const R = orbitRadius(w, h);
  const c = centreClear(w, h);
  const nodes = orbitNodes(hud.launcher.length, w, h);
  const usageR = 0.68 * R;
  const placed = placeWidgets(widgets.filter(edge), w, h);
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
      <div className="ob-orb-label" style={{ left: c.cx, top: c.cy }} aria-hidden="true">
        <b>{(state.assistantName || "FRIEND").toUpperCase()}</b>
        <small>{state.voice.mode}</small>
      </div>
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
        return (
          <Safe key={item.id}>
            <HexNode x={n.x} y={n.y} label={item.label} glyph={item.icon} caption={item.label} onClick={() => onLaunch(item)} />
          </Safe>
        );
      })}
      <Safe>
        <TopBar hud={hud} state={state} rect={zoneRect("top", w, h)} />
      </Safe>
      {widgets.filter(edge).map((d) => frame(d, px(placed.get(d.id)!)))}
      <p className="ob-hint" style={{ left: ZONE_GAP, top: zoneRect("bottom", w, h).y, width: w - 2 * ZONE_GAP, height: zoneRect("bottom", w, h).height }}>▸ press and hold to talk · tap to type</p>
      {expandedEl}
      {modalEl}
    </div>
  );
}
