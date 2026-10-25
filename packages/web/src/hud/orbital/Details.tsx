import type { JarvisNode } from "@friend/protocol";
import type { ReactNode } from "react";
import type { StageViewState } from "../../store";
import { JLive } from "./JLive";
import { formatBytes } from "./widgets/NetworkWidget";
import { STATS_STALE_MS } from "./widgets/SystemWidget";

/**
 * What opens when a live instrument is clicked. The pictures (gauges, trend lines, the waveform) are Jarvis components; every word and
 * number is set in the screen's own type, so the dialog reads like the rest of the screen, and says what the figures mean and what to do.
 */

const pct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
const gauge = (value: number, label: string, size = "200px"): JarvisNode => ({ c: "JGaugeChart", p: { value: pct(value), min: 0, max: 100, size, label, displayValue: `${pct(value)}%`, showNeedle: false, showTicks: false, showMinMax: false } });
const spark = (data: number[], width = "260px"): JarvisNode => ({ c: "JSparkline", p: { data: data.length > 1 ? data : [0, 0], showArea: true, showTrend: false, height: "48px", width } });
const row = (...kids: JarvisNode[]): JarvisNode => ({ c: "Row", p: { gap: 24 }, kids });

/** A picture drawn with Jarvis components, with nothing in its place while the library is on its way. */
function Pic({ node }: { node: JarvisNode }) {
  return (
    <JLive node={node}>
      <span className="ob-pic-wait" />
    </JLive>
  );
}

function Fact({ k, v, tone }: { k: string; v: ReactNode; tone?: "warn" | "ok" }) {
  return (
    <p className={`ob-fact${tone ? ` ob-fact-${tone}` : ""}`}>
      <span>{k}</span>
      <b>{v}</b>
    </p>
  );
}

const Say = ({ children }: { children: ReactNode }) => <p className="ob-say">{children}</p>;
const Head = ({ children }: { children: ReactNode }) => <p className="ob-sub ob-head">{children}</p>;

const ago = (ms: number): string => (ms < 5_000 ? "just now" : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`);

/** The last readings the screen kept (newest last), so a trend is there the moment a dialog opens. */
export interface Readings {
  cpu: number[];
  ram: number[];
  down: number[];
  up: number[];
}

export function SystemDetails({ stats, cpuHist, ramHist }: { stats: StageViewState["stats"]; cpuHist: number[]; ramHist: number[] }) {
  const cpu = stats ? pct(stats.cpu) : 0;
  const ram = stats && stats.ramTotal > 0 ? pct((100 * stats.ramUsed) / stats.ramTotal) : 0;
  if (!stats) return <Say>Waiting for the first reading from this PC.</Say>;
  const stale = Date.now() - stats.at > STATS_STALE_MS;
  const verdict =
    cpu > 85 || ram > 92
      ? "The PC is under heavy load. If it feels slow, close big programs or browser tabs you are not using."
      : cpu > 60 || ram > 80
        ? "Busy, but fine. Nothing needs doing unless it feels slow."
        : "Light load. There is plenty of room for more work.";
  return (
    <div className="ob-details">
      <div className="ob-pics">
        <Pic node={gauge(cpu, "CPU")} />
        <Pic node={gauge(ram, "Memory")} />
      </div>
      <Fact k="Processor now" v={`${cpu}%`} tone={cpu > 85 ? "warn" : undefined} />
      <Fact k="Memory now" v={`${ram}%  (${formatBytes(stats.ramUsed)} of ${formatBytes(stats.ramTotal)})`} tone={ram > 92 ? "warn" : undefined} />
      <Fact k="Memory free" v={formatBytes(Math.max(0, stats.ramTotal - stats.ramUsed))} />
      <Fact k="Last reading" v={stale ? `${ago(Date.now() - stats.at)} (stale: the PC agent may be off)` : ago(Date.now() - stats.at)} tone={stale ? "warn" : "ok"} />
      <Head>Last minute or so</Head>
      <div className="ob-pics">
        <Pic node={spark(cpuHist, "230px")} />
        <Pic node={spark(ramHist, "230px")} />
      </div>
      <p className="ob-trend">processor, then memory</p>
      <Say>{verdict}</Say>
    </div>
  );
}

export function VoiceDetails({ voice, lastHeard }: { voice: StageViewState["voice"]; lastHeard: string | null }) {
  const live = voice.mode !== "idle" || voice.level > 0.05;
  const doing = { idle: "Waiting", listening: "Listening to you", transcribing: "Turning your words into text", speaking: "Speaking" }[voice.mode];
  return (
    <div className="ob-details">
      <Pic node={{ c: "JWaveform", p: { barCount: 36, height: "64px", active: live } }} />
      <Fact k="Doing now" v={doing} tone={live ? "ok" : undefined} />
      <Fact k="Sound level" v={`${Math.round(voice.level * 100)}%`} />
      <Fact k="Voice on this PC" v={voice.available ? "ready" : "not set up"} tone={voice.available ? "ok" : "warn"} />
      <Fact k="Your voice enrolled" v={voice.enrolled ? "yes: strangers are recognised" : "no"} />
      {lastHeard && <Fact k="You last said" v={lastHeard.length > 90 ? `${lastHeard.slice(0, 89)}…` : lastHeard} />}
      <Say>{voice.available ? "Hold Space (or press and hold the talk button) and speak; let go to send. Friend answers aloud when you spoke to it." : "Voice is not set up on this PC yet. Run friend voice setup in the terminal, then restart Friend."}</Say>
    </div>
  );
}

export function NetworkDetails({ stats, down, up }: { stats: StageViewState["stats"]; down: number[]; up: number[] }) {
  if (!stats) return <Say>Waiting for the first reading from this PC.</Say>;
  const none = stats.netDown === 0 && stats.netUp === 0;
  return (
    <div className="ob-details">
      <div className="ob-pics">
        <Pic node={spark(down, "260px")} />
        <Pic node={spark(up, "260px")} />
      </div>
      <p className="ob-trend">downloading, then uploading</p>
      <Fact k="Download now" v={none ? "n/a" : `${formatBytes(stats.netDown)}/s`} />
      <Fact k="Upload now" v={none ? "n/a" : `${formatBytes(stats.netUp)}/s`} />
      <Fact k="Fastest download seen" v={down.length ? `${formatBytes(Math.max(...down))}/s` : "n/a"} />
      <Fact k="Fastest upload seen" v={up.length ? `${formatBytes(Math.max(...up))}/s` : "n/a"} />
      <Say>{none ? "This PC does not report network speed, or nothing is moving right now." : "The speed of everything on this PC, not only Friend. A busy line usually means a download, an update or a video."}</Say>
    </div>
  );
}

export function DeviceDetails({ deviceOnline, voiceAvailable }: { deviceOnline: boolean; voiceAvailable: boolean }) {
  const dev = (name: string, up: boolean, what: string, off: string) => (
    <div className="ob-device" key={name}>
      <Fact k={name} v={up ? "online" : "offline"} tone={up ? "ok" : "warn"} />
      <p className="ob-say ob-small">{up ? what : off}</p>
    </div>
  );
  return (
    <div className="ob-details">
      {dev("This screen", true, "You are looking at it: Friend shows pictures, captions and these instruments here.", "")}
      {dev("PC agent", deviceOnline, "Runs commands and reads files on this PC when you ask, after your approval.", "Friend cannot run commands or read files on this PC until the agent is running again (friend start).")}
      {dev("Voice", voiceAvailable, "Listens when you hold Space and speaks the answers.", "Voice is not set up on this PC yet (friend voice setup).")}
    </div>
  );
}

export function TicketDetails({ office }: { office: StageViewState["office"] }) {
  if (!office.enabled) return <Say>The Office is switched off, so there are no workers or tickets. Turn it on in Settings, Office, then ask Friend to hire someone.</Say>;
  const by = (s: string) => office.tickets.filter((t) => t.status === s).length;
  const name = (id: string | null) => office.workers.find((w) => w.id === id)?.name ?? (id ? id : "nobody yet");
  const shown = [...office.tickets].sort((a, b) => b.id - a.id).slice(0, 8);
  return (
    <div className="ob-details">
      <Fact k="Done" v={by("done")} tone="ok" />
      <Fact k="Being worked on" v={by("doing")} />
      <Fact k="Waiting for review" v={by("review") + by("blocked")} tone={by("review") + by("blocked") > 0 ? "warn" : undefined} />
      <Fact k="Not started" v={by("todo")} />
      <Head>Newest tickets</Head>
      {shown.length === 0 && <Say>No tickets yet. Ask Friend to give a worker something to do.</Say>}
      {shown.map((t) => (
        <p key={t.id} className="ob-li ob-wrap">
          #{t.id} · {t.title} · {t.status} · {name(t.workerId)}
        </p>
      ))}
    </div>
  );
}
