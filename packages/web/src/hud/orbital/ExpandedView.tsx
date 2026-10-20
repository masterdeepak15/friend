import type { HudWidgetId } from "@friend/protocol";
import { useEffect, useRef, useState } from "react";
import { httpUsageApi, short, type UsageApi, type UsageSummary } from "../../settings/UsageTab";
import type { StageViewState } from "../../store";
/** A rectangle on the screen, in pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
import { Frame } from "./kit";
import { budgetRings, ticketCells, ticketProject } from "./office";
import { WIDGETS } from "./registry";
import { BudgetWidget } from "./widgets/BudgetWidget";
import { FeedLog } from "./widgets/FeedWidget";
import { NetworkWidget } from "./widgets/NetworkWidget";
import { RadarWidget } from "./widgets/RadarWidget";
import { SystemWidget } from "./widgets/SystemWidget";
import { TicketsWidget } from "./widgets/TicketsWidget";
import { VoiceWidget } from "./widgets/VoiceWidget";

/** What each instrument is, in plain words, shown under it when it is opened. */
const EXPLAIN: Record<HudWidgetId, string> = {
  system: "How hard this PC is working. The big arc is the processor; the thin arc inside it is the memory.",
  voice: "The sound Friend is hearing or speaking, live.",
  network: "How fast data moves in and out of this PC. Some PCs do not report it.",
  feed: "The conversation and what Friend is doing right now.",
  radar: "The things Friend can reach: this screen, the PC's agent and the voice. A dim one is offline.",
  tickets: "The work given to hired workers, one cell each. Switch the Office on in Settings to hire workers.",
  budget: "How much of each worker's limit is used. Limits are set in Settings, Office.",
  approval: "Something is waiting for your answer.",
  usage: "Today's usage compared with your busiest day of the last 30.",
};

const SOURCE: Record<string, string> = { voice: "Voice", chat: "Chat", task: "Scheduled tasks", channel: "Messages", other: "Other" };

/** Where the usage of the last 30 days went, by source. */
function UsageDetail({ api }: { api: UsageApi }) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.summary(30).then((s) => live && setSummary(s)).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [api]);
  if (failed) return <p className="ob-li ob-sub">Could not read the usage</p>;
  if (!summary) return <p className="ob-li ob-sub">Reading…</p>;
  if (summary.bySource.length === 0) return <p className="ob-li ob-sub">No usage yet</p>;
  return (
    <div className="ob-usage-detail">
      {summary.bySource.map((s) => (
        <p key={s.source} className="ob-li">
          {SOURCE[s.source] ?? s.source} · {short(s.input + s.output)} tokens · {s.turns} turns
        </p>
      ))}
    </div>
  );
}

export interface ExpandedViewProps {
  id: HudWidgetId;
  state: StageViewState;
  rect: Rect;
  usageApi?: UsageApi;
  onClose: () => void;
}

/** One instrument, large, in the middle of the screen. */
export function ExpandedView({ id, state, rect, usageApi = httpUsageApi, onClose }: ExpandedViewProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), [id]); // the keyboard moves in with it
  const title = WIDGETS.find((w) => w.id === id)?.title ?? id;
  const body = (() => {
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
        return <FeedLog lines={state.chat} activity={state.activity} busy={state.busy} />;
      case "tickets":
        return <TicketsWidget cells={ticketCells(state.office.tickets)} {...(ticketProject(state.office.tickets) ? { project: ticketProject(state.office.tickets)! } : {})} />;
      case "budget":
        return <BudgetWidget rings={budgetRings(state.office.workers)} />;
      case "usage":
        return <UsageDetail api={usageApi} />;
      default:
        return null;
    }
  })();
  return (
    <Frame variant="chamfer" running title={title} className="ob-expanded ob-hit" style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height }} role="dialog" aria-label={title}>
      <button ref={closeRef} type="button" className="ob-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <div className="ob-expanded-body">{body}</div>
      <p className="ob-explain">{EXPLAIN[id]}</p>
    </Frame>
  );
}