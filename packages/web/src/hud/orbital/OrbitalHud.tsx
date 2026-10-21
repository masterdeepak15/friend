import type { ClientMsg, HudView, HudWidgetId } from "@friend/protocol";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { describeStatus } from "../../overlay/StatusBadge";
import type { UsageApi } from "../../settings/UsageTab";
import type { StageViewState } from "../../store";
import { ExpandedView } from "./ExpandedView";
import { budgetRings, feedLines, officeMood, ticketCells, ticketProject, usageFromQuota, workerNodes } from "./office";
import { WorkerView } from "./WorkerView";
import { OrgChart } from "./OrgChart";
import { DESIGN_H, DESIGN_W, ORBIT_R, centreClear, designScale, layoutMode, orbitNodes, screenOf, type Anchor } from "./geometry";
import { Frame, HexNode, HudDefs, LinkLine, SegmentedRing, type NodeStatus, type Tone } from "./kit";
import { visibleWidgets, type WidgetDef } from "./registry";
import { SAMPLE_APPROVAL, SAMPLE_BLIPS, SAMPLE_BUDGET, SAMPLE_FEED, SAMPLE_NODES, SAMPLE_TICKETS, SAMPLE_USAGE, sampleStats } from "./sample";
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
  /** Opens the place where a worker is hired (Settings, Office); the "+" node on the orbit asks for it. */
  onHire?: () => void;
  onLaunch: (item: Launcher) => void;
  onExpand: (target: ExpandId) => void;
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

const activate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

const statusText = (state: StageViewState): string => describeStatus({ connection: state.connection, deviceOnline: state.deviceOnline, approval: state.approval, voiceMode: state.voice.mode, busy: state.busy, activity: state.activity }).text;

/** One line for each instrument, for the small cards of the phone layout. */
function summaryOf(id: HudWidgetId, state: StageViewState): string {
  const s = state.stats;
  switch (id) {
    case "system":
      return s ? `CPU ${Math.round(s.cpu)}% · RAM ${s.ramTotal > 0 ? Math.round((100 * s.ramUsed) / s.ramTotal) : 0}%` : "Waiting for data";
    case "voice":
      return state.voice.mode;
    case "network":
      return s ? (s.netDown === 0 && s.netUp === 0 ? "n/a" : `↓ ${Math.round(s.netDown / 1024)} KB/s ↑ ${Math.round(s.netUp / 1024)} KB/s`) : "Waiting for data";
    case "feed":
      return state.chat.at(-1)?.text ?? "Nothing yet";
    case "radar":
      return ["This screen", state.deviceOnline ? "PC" : null, state.voice.available ? "Voice" : null].filter(Boolean).join(" · ");
    case "approval":
      return "None waiting";
    default:
      return state.office.enabled && state.office.workers.length > 0 ? `${state.office.workers.length} worker${state.office.workers.length === 1 ? "" : "s"}` : "No workers yet";
  }
}

function UsageLabel({ usage, reset = null, real = false, style, onClick }: { usage: number | null | undefined; reset?: string | null; real?: boolean; style?: CSSProperties; onClick: () => void }) {
  const known = typeof usage === "number" && Number.isFinite(usage);
  return (
    <button type="button" className="ob-usage-label ob-hit" data-widget="usage" title={real ? "How full your Claude subscription's five-hour window is" : "Today's usage compared with your busiest day of the last 30"} style={style} onClick={onClick} aria-label={known ? (real ? `Usage ${Math.round(usage)} percent of the five-hour window${reset ? `, resets in ${reset}` : ""}` : `Usage ${Math.round(usage)} percent of your busiest day`) : "Usage, no data yet"}>
      USAGE {known ? `${Math.round(usage)}%` : "—"}{reset ? ` · RESET ${reset}` : ""}
    </button>
  );
}

/** The notched top line, the product name and the two corner texts, drawn on the canvas as in the approved mockup. */
function TopBar({ hud, state, preview }: { hud: HudView; state: StageViewState; preview: boolean }) {
  const now = useNow(hud.clock.seconds ? 1000 : 15_000);
  const locale = hud.clock.locale || undefined;
  const time = now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", ...(hud.clock.seconds ? { second: "2-digit" } : {}), hour12: hud.clock.hour12 });
  const date = now.toLocaleDateString(locale, { weekday: "short", day: "2-digit", month: "short" });
  const line = "M330 44H560L590 20H1010L1040 44H1270";
  const online = state.connection === "open";
  return (
    <g data-testid="orbital-topbar">
      <path className="ob-topbar-base" d={line} />
      <path className="ob-topbar-run" d={line} pathLength={100} />
      <text className="ob-title" x="800" y="40" textAnchor="middle">F R I E N D</text>
      {preview && <text className="ob-sample-tag" x="800" y="62" textAnchor="middle">SAMPLE DATA · NOT REAL</text>}
      <circle className={online ? "ob-pulse" : undefined} cx="30" cy="34" r="4" fill={online ? "#34d399" : "#fb923c"} />
      <text className="ob-lab" x="40" y="38">{(state.assistantName || "FRIEND").toUpperCase()} · {online ? "ONLINE" : "OFFLINE"}</text>
      <text className="ob-dim" x="40" y="58">{hud.terminalLabel} · VOICE · {state.voice.mode}   LINK · {typeof location === "undefined" ? "" : location.host}</text>
      <text className="ob-lab" x="1560" y="38" textAnchor="end">{time} · {date}</text>
    </g>
  );
}

/**
 * The orbital screen: the 1600 x 900 canvas of the approved mockup, scaled to the window. It is drawn inside the stage, above the
 * orb and below the pictures the assistant puts up. It only takes the pointer on the nodes and instruments, so a press anywhere
 * else still reaches the stage.
 */
export function OrbitalHud({ hud, state, usage = null, viewport, usageApi, send = () => {}, onHire, onLaunch, onExpand }: OrbitalHudProps) {
  const { w, h } = useWindowSize(viewport);
  const hidden = useHidden();
  const mode = layoutMode(w, h);
  // "Show sample data" previews the whole look, so every instrument is drawn (unless switched off by hand)
  const preview = hud.preview === true && mode === "orbit";
  const widgets = visibleWidgets(preview ? "full" : hud.density, hud.widgets, mode, state.approval !== null);
  const view: StageViewState = preview ? { ...state, stats: sampleStats(Date.now()), voice: { ...state.voice, mode: "listening", level: 0.85 } } : state;
  const pending = state.approval !== null;
  const needsPin = state.approval?.needsPin === true;
  const toneOf = (def: WidgetDef): Tone => (def.id === "approval" ? (pending ? "orange" : "cyan") : def.tone);
  // One instrument can be open, large, in the middle; Esc, a press outside or the close mark shuts it and the focus goes back to where it was.
  const [expanded, setExpanded] = useState<HudWidgetId | null>(null);
  const [openWorker, setOpenWorker] = useState<string | null>(null);
  const [showOrg, setShowOrg] = useState(false);
  const tick = useNow(30_000); // the time the usage window resets in is worked out from this
  const opener = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    setExpanded(null);
    setOpenWorker(null);
    setShowOrg(false);
    opener.current?.focus();
    opener.current = null;
  }, []);
  const open = (id: HudWidgetId) => () => {
    if (expanded === null && openWorker === null && !showOrg) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpenWorker(null);
    setShowOrg(false);
    setExpanded(id);
    onExpand({ kind: "widget", id });
  };
  useEffect(() => {
    if ((expanded === null && openWorker === null && !showOrg) || pending) return;
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation(); // the Esc that closes this must not also open the owner menu
      close();
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [expanded, openWorker, showOrg, pending, close]);
  const openW = mode === "compact" ? w - 16 : Math.max(280, Math.min(760, w * 0.62));
  const expandedRect = { x: (w - openW) / 2, y: h * 0.14, width: openW, height: Math.max(220, Math.min(560, h * 0.7)) };
  // a waiting approval comes first: any open instrument closes, and a PIN is asked in a dialog in the middle (big enough for the pad, full width on a phone)
  const shownExpanded = pending ? null : expanded;
  const expandedEl = shownExpanded && (
    <>
      <div className="ob-backdrop ob-hit" onPointerDown={(e) => { e.stopPropagation(); close(); }} />
      <Safe>
        <ExpandedView id={shownExpanded} state={state} rect={expandedRect} {...(usageApi ? { usageApi } : {})} onClose={close} />
      </Safe>
    </>
  );
  // a hired worker, large, in the middle: its feed, a Stop button and a box to say something to it
  const officeOn = state.office.enabled && !preview;
  const shownWorker = pending || !officeOn ? undefined : state.office.workers.find((x) => x.id === openWorker);
  const showWorker = (id: string) => {
    if (expanded === null && openWorker === null && !showOrg) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setExpanded(null);
    setShowOrg(false);
    setOpenWorker(id);
  };
  const hasTeam = officeOn && state.office.workers.length > 0;
  const showTeam = () => {
    if (expanded === null && openWorker === null && !showOrg) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setExpanded(null);
    setOpenWorker(null);
    setShowOrg(true);
  };
  const orgRect = { ...expandedRect, x: Math.max(8, expandedRect.x - 60), width: Math.min(w - 16, expandedRect.width + 120) };
  const orgEl = showOrg && hasTeam && !pending && (
    <>
      <div className="ob-backdrop ob-hit" onPointerDown={(e) => { e.stopPropagation(); close(); }} />
      <Safe>
        <OrgChart workers={state.office.workers} name={state.assistantName || "Friend"} rect={orgRect} onWorker={showWorker} onClose={close} />
      </Safe>
    </>
  );
  const workerEl = shownWorker && (
    <>
      <div className="ob-backdrop ob-hit" onPointerDown={(e) => { e.stopPropagation(); close(); }} />
      <Safe>
        <WorkerView worker={shownWorker} feed={state.office.feed[shownWorker.id] ?? []} rect={expandedRect} send={send} onClose={close} />
      </Safe>
    </>
  );
  const modalW = mode === "compact" ? w - 16 : Math.max(340, Math.min(480, w * 0.34));
  const modalH = Math.min(h - 16, Math.max(300, Math.min(520, h * 0.7)));
  const modalRect = { x: (w - modalW) / 2, y: (h - modalH) / 2, width: modalW, height: modalH };
  const asDialog = pending && (needsPin || mode === "compact");
  const modalEl = asDialog && (
    <>
      <div className="ob-backdrop ob-modal-backdrop" />
      <Safe>
        <Frame data-widget="approval" variant="octagon" tone="orange" title="Approvals" running className="ob-zone ob-hit ob-static ob-modal" style={{ position: "absolute", left: modalRect.x, top: modalRect.y, width: modalRect.width, height: modalRect.height }}>
          <ApprovalWidget approval={state.approval} send={send} />
        </Frame>
      </Safe>
    </>
  );
  const root = { className: "orbital", "data-testid": "orbital", "data-mode": mode, "data-hud-anim": hud.animations, ...(hidden ? { "data-paused": "" } : {}) };
  const hasUsage = widgets.some((d) => d.id === "usage");
  const realUsage = preview ? { value: SAMPLE_USAGE, reset: null, real: false } : usageFromQuota(state.office.quota, usage, tick.getTime());

  const content = (id: HudWidgetId) => {
    switch (id) {
      case "system":
        return <SystemWidget stats={view.stats} />;
      case "network":
        return <NetworkWidget stats={view.stats} />;
      case "radar":
        return <RadarWidget deviceOnline={view.deviceOnline} voiceAvailable={view.voice.available} {...(preview ? { blips: SAMPLE_BLIPS } : {})} />;
      case "voice":
        return <VoiceWidget level={view.voice.level} mode={view.voice.mode} />;
      case "feed": {
        const workerLines = officeOn ? feedLines(state.office.feed, state.office.workers) : [];
        return <FeedWidget lines={preview ? SAMPLE_FEED : workerLines.length > 0 ? workerLines : view.chat} activity={view.activity} busy={preview || workerLines.length > 0 ? false : view.busy} marquee={preview} />;
      }
      case "tickets":
        if (officeOn) return <TicketsWidget cells={ticketCells(state.office.tickets)} {...(ticketProject(state.office.tickets) ? { project: ticketProject(state.office.tickets)! } : {})} />;
        return <TicketsWidget {...(preview ? { cells: SAMPLE_TICKETS, project: "landing-page" } : {})} />;
      case "budget":
        return <BudgetWidget {...(preview ? { rings: SAMPLE_BUDGET } : officeOn ? { rings: budgetRings(state.office.workers) } : {})} />;
      default:
        return null;
    }
  };
  if (mode === "compact") {
    const card = (def: WidgetDef) => (
      <Safe key={def.id}>
        <Frame data-widget={def.id} variant="chamfer" tone={toneOf(def)} title={def.title} className="ob-zone ob-hit" style={{ minWidth: 170, height: 100, flex: "none" }} role="button" tabIndex={0} aria-label={def.title} onClick={open(def.id)} onKeyDown={activate(open(def.id))}>
          <p className="ob-li">{summaryOf(def.id, state)}</p>
        </Frame>
      </Safe>
    );
    return (
      <div {...root}>
        <HudDefs />
        <div className="ob-chips">
          {hasTeam && (
            <button type="button" className="ob-chip ob-hit" onClick={showTeam}>
              Team · {state.office.workers.length}
            </button>
          )}
          {officeOn && state.office.workers.map((x) => (
            <button key={x.id} type="button" className="ob-chip ob-hit" onClick={() => showWorker(x.id)}>
              {x.name}
            </button>
          ))}
          {hud.launcher.map((item) => (
            <button key={item.id} type="button" className="ob-chip ob-hit" onClick={() => onLaunch(item)}>
              <span aria-hidden="true">{item.icon}</span> {item.label}
            </button>
          ))}
        </div>
        <p className="ob-compact-status">{statusText(state)}</p>
        <div className="ob-strip">
          {widgets.filter((d) => d.anchor !== "centre" && !(d.id === "approval" && pending)).map(card)}
          {hasUsage && <UsageLabel usage={realUsage.value} reset={realUsage.reset} real={realUsage.real} onClick={open("usage")} />}
        </div>
        {expandedEl}
        {workerEl}
        {orgEl}
        {modalEl}
      </div>
    );
  }

  const s = designScale(w, h);
  const c = centreClear(DESIGN_W, DESIGN_H);
  // the quick-launch buttons, or the sample workers of the mockup
  interface OrbitItem {
    id: string;
    label: string;
    glyph: string;
    caption?: string;
    status: NodeStatus;
    detail?: string;
    at?: { x: number; y: number; anchor: "start" | "middle" | "end" };
    onClick: () => void;
  }
  const launcherItems: OrbitItem[] = hud.launcher.map((item) => ({ id: item.id, label: item.label, glyph: item.icon, caption: item.label, status: "idle" as NodeStatus, onClick: () => onLaunch(item) }));
  // With the Office on, the hired workers are the nodes (the slots are the same ones as the sample workers use, so their lines sit in the same places);
  // until someone is hired the launcher stays, with a "+" beside it.
  const workers = officeOn ? workerNodes(state.office.workers, true) : [];
  const hireItem = (n: (typeof workers)[number]): OrbitItem => ({ id: n.id, label: n.label, glyph: n.glyph, caption: n.caption, status: n.status, onClick: () => onHire?.() });
  const officeItems: OrbitItem[] = workers.map((n, i) => (n.kind === "hire" ? hireItem(n) : { id: n.id, label: n.label, glyph: n.glyph, caption: n.caption, status: n.status, detail: n.detail, ...(SAMPLE_NODES[i] ? { at: SAMPLE_NODES[i]!.at } : {}), onClick: () => showWorker(n.id) }));
  const items: OrbitItem[] = preview
    ? SAMPLE_NODES.map((n) => ({ id: n.id, label: n.label, glyph: n.label, status: n.status, detail: n.detail, at: n.at, onClick: () => {} }))
    : !officeOn
      ? launcherItems
      : state.office.workers.length > 0
        ? officeItems
        : [...launcherItems, ...officeItems];
  const nodes = orbitNodes(items.length, DESIGN_W, DESIGN_H);
  const shownUsage = realUsage.value;
  const canvas = (anchor: Anchor, name: string, children: ReactNode) => {
    const at = screenOf(anchor, 0, 0, w, h);
    return (
      <div className={`ob-canvas ob-canvas-${name}`} style={{ left: at.x, top: at.y, width: DESIGN_W, height: DESIGN_H, transform: `scale(${s})` }}>
        {children}
      </div>
    );
  };
  const zone = (def: WidgetDef) => {
    const box = { left: def.box.x, top: def.box.y, width: def.box.w, height: def.box.h };
    if (def.id === "approval") {
      if (asDialog) return null; // asked in the dialog in the middle
      return (
        <Safe key={def.id}>
          <div data-widget="approval" className="ob-w ob-hit ob-static" style={box}>
            {pending ? (
              <Frame variant="octagon" tone="orange" running className="ob-approval-frame">
                <ApprovalWidget approval={state.approval} send={send} />
              </Frame>
            ) : preview ? (
              <Frame variant="octagon" tone="orange" running className="ob-approval-frame">
                <ApprovalWidget approval={SAMPLE_APPROVAL} send={() => {}} />
              </Frame>
            ) : (
              <Frame variant="bracket" title="Approvals">
                <ApprovalWidget approval={null} send={send} />
              </Frame>
            )}
          </div>
        </Safe>
      );
    }
    return (
      <Safe key={def.id}>
        <div data-widget={def.id} className="ob-w ob-hit" style={box} role="button" tabIndex={0} aria-label={def.title} onClick={open(def.id)} onKeyDown={activate(open(def.id))}>
          {content(def.id)}
        </div>
      </Safe>
    );
  };
  const edge = (anchor: Anchor) => widgets.filter((d) => d.anchor === anchor);
  const name = (state.assistantName || "FRIEND").toUpperCase();
  const amp = Math.min(1, Math.max(0, state.voice.level, state.presence.amplitude));
  const base = screenOf("centre", 0, 0, w, h);

  return (
    <>
      {/* under the stage's orb: the radial background and the orb's glowing disc, which swells with the voice */}
      <div className="ob-base" aria-hidden="true">
        <div className="ob-canvas" style={{ left: base.x, top: base.y, width: DESIGN_W, height: DESIGN_H, transform: `scale(${s})` }}>
          <svg className="ob-scene" width={DESIGN_W} height={DESIGN_H} viewBox={`0 0 ${DESIGN_W} ${DESIGN_H}`}>
            <g className="ob-disc-wrap" style={{ transform: `scale(${Number((1 + 0.18 * amp).toFixed(3))})` }}>
              <circle className="ob-disc ob-breathe" cx={c.cx} cy={c.cy} r="104" fill="url(#ob-orbg)" filter="url(#ob-glow2)" />
            </g>
          </svg>
        </div>
      </div>
    <div {...root} style={{ ["--s" as string]: s } as CSSProperties}>
      <HudDefs />
      <div className="ob-bg" aria-hidden="true" />
      <span className="ob-corner ob-tl" aria-hidden="true" />
      <span className="ob-corner ob-tr" aria-hidden="true" />
      <span className="ob-corner ob-bl" aria-hidden="true" />
      <span className="ob-corner ob-br" aria-hidden="true" />
      {canvas(
        "centre",
        "centre",
        <>
          <svg className="ob-scene" width={DESIGN_W} height={DESIGN_H} viewBox={`0 0 ${DESIGN_W} ${DESIGN_H}`} aria-hidden="true">
            <Safe>
              <TopBar hud={hud} state={view} preview={preview} />
            </Safe>
            <circle cx={c.cx} cy={c.cy} r="104" className="ob-orb-ring" />
            <circle cx={c.cx} cy={c.cy} r="104" className="ob-ping" />
            <g className="ob-spin ob-fast"><circle cx={c.cx} cy={c.cy} r="128" className="ob-ring-dash" /></g>
            <g className="ob-spin ob-reverse"><circle cx={c.cx} cy={c.cy} r="150" className="ob-ring-long" /></g>
            <g className="ob-spin"><circle cx={c.cx} cy={c.cy} r="172" className="ob-ring-thin" /></g>
            <circle cx={c.cx} cy={c.cy} r={ORBIT_R} className="ob-orbit" />
            <g className="ob-spin ob-reverse ob-slow"><circle cx={c.cx} cy={c.cy} r="330" className="ob-ring-outer" /></g>
            {nodes.map((n, i) => {
              const dir = { x: Math.cos((n.angle * Math.PI) / 180), y: Math.sin((n.angle * Math.PI) / 180) };
              return <LinkLine key={items[i]!.id} tone={items[i]!.status === "waiting" ? "orange" : "cyan"} x1={c.cx + dir.x * 104} y1={c.cy + dir.y * 104} x2={c.cx + dir.x * (ORBIT_R - 34)} y2={c.cy + dir.y * (ORBIT_R - 34)} />;
            })}
            {items.map((it) => it.at && it.detail && <text key={it.id} className={`ob-node-detail${it.status === "running" ? " ob-grn" : it.status === "waiting" ? " ob-org" : ""}`} x={it.at.x} y={it.at.y} textAnchor={it.at.anchor}>{it.detail}</text>)}
          </svg>
          {hasTeam && (
            <button type="button" className="ob-team-btn ob-hit" style={{ left: c.cx, top: c.cy + 52 }} onClick={showTeam}>
              TEAM · {state.office.workers.length}
            </button>
          )}
          <div className="ob-orb-label" style={{ left: c.cx, top: c.cy }} aria-hidden="true">
            <b>{name}</b>
            <small>{officeMood(state.voice.mode, preview ? { enabled: false, workers: [] } : state.office)}</small>
          </div>
          {hasUsage && (
            <>
              <div className="ob-usage-ring" style={{ left: c.cx - 230, top: c.cy - 230, width: 460, height: 460 }}>
                <SegmentedRing value={shownUsage ?? 0} radius={205} size={460} />
              </div>
              <UsageLabel usage={shownUsage} reset={realUsage.reset} real={realUsage.real} style={{ position: "absolute", left: 800, top: 692, transform: "translate(-50%, -50%)" }} onClick={open("usage")} />
            </>
          )}
          {nodes.map((n, i) => {
            const it = items[i]!;
            return (
              <Safe key={it.id}>
                <HexNode x={n.x} y={n.y} label={it.label} glyph={it.glyph} status={it.status} {...(it.caption ? { caption: it.caption } : {})} {...(it.detail ? { detail: it.detail } : {})} onClick={it.onClick} />
              </Safe>
            );
          })}
          <div className="ob-cmd" aria-hidden="true">
            <small>[ HOLD TO TALK ]</small>
          </div>
        </>,
      )}
      {canvas("left", "left", edge("left").map(zone))}
      {canvas("right", "right", edge("right").map(zone))}
      {expandedEl}
      {workerEl}
      {orgEl}
      {modalEl}
    </div>
    </>
  );
}
