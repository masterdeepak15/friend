import type { MusicView } from "@friend/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Movable } from "../layout/Movable";
import { ripple, useScramble } from "../hud/fx";
import { IconClose, IconCollapse, IconExpand, IconMute, IconNext, IconPause, IconPlay, IconPrev, IconRepeat, IconShuffle, IconVolume } from "../hud/icons";
import { Dial, newLevels, type Levels } from "./Dial";
import type { Track } from "./playerCore";
import type { MusicPlayer as Player } from "./useMusicPlayer";

type Anim = "full" | "reduced" | "off";

const clock = (sec: number): string => {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The cover picture of a track, or null when it has none (checked once per track). */
const covers = new Map<string, boolean>();
function useCover(id: string | undefined): string | null {
  const [ok, setOk] = useState<boolean>(id ? (covers.get(id) ?? false) : false);
  useEffect(() => {
    if (!id) return setOk(false);
    if (covers.has(id)) return setOk(covers.get(id)!);
    let live = true;
    const img = new Image();
    img.onload = () => {
      covers.set(id, true);
      if (live) setOk(true);
    };
    img.onerror = () => {
      covers.set(id, false);
      if (live) setOk(false);
    };
    img.src = `/api/music/cover/${id}`;
    return () => {
      live = false;
    };
  }, [id]);
  return id && ok ? `/api/music/cover/${id}` : null;
}

interface Row extends Track {
  cover?: boolean;
}
async function fetchLibrary(q: string, limit: number): Promise<{ tracks: Row[]; total: number }> {
  const res = await fetch(`/api/music/library?q=${encodeURIComponent(q)}&limit=${limit}`);
  if (!res.ok) return { tracks: [], total: 0 };
  return (await res.json()) as { tracks: Row[]; total: number };
}
const asTrack = (r: Row): Track => ({ id: r.id, title: r.title, artist: r.artist, album: r.album, durationSec: r.durationSec });

/** The level bars at the sides of the full view: they light up with the sound. */
function LevelBars({ levels, animate, side }: { levels: Levels; animate: boolean; side: "left" | "right" }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!animate) return;
    let raf = 0;
    const el = box.current;
    const draw = () => {
      if (el) {
        const v = side === "left" ? levels.left : levels.right;
        const lit = Math.round(v * 12);
        el.querySelectorAll("i").forEach((seg, i) => seg.classList.toggle("on", i < lit));
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [levels, animate, side]);
  return (
    <div ref={box} className={`hud-levels ${side}`} aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}

function Transport({ player, anim }: { player: Player; anim: Anim }) {
  const { state, dispatch } = player;
  const playAll = useCallback(async () => {
    if (state.queue.length > 0) return dispatch({ type: "resume" });
    const lib = await fetchLibrary("", 500);
    dispatch({ type: "play", tracks: lib.tracks.map(asTrack), mode: "replace", ...(state.shuffle ? { shuffle: true } : {}) });
  }, [state.queue.length, state.shuffle, dispatch]);
  const press = (fn: () => void) => (e: React.PointerEvent<HTMLElement>) => {
    if (anim !== "off") ripple(e);
    fn();
  };
  return (
    <div className="hud-controls" role="group" aria-label="Player controls">
      <button type="button" className="hud-btn" aria-label="Shuffle" aria-pressed={state.shuffle} title="Shuffle" onClick={() => dispatch({ type: "shuffle" })}>
        <IconShuffle />
      </button>
      <button type="button" className="hud-btn" aria-label="Previous track" title="Previous" onPointerDown={press(() => {})} onClick={() => dispatch({ type: "previous" })}>
        <IconPrev />
      </button>
      <button
        type="button"
        className="hud-btn hud-btn-main"
        aria-label={state.playing ? "Pause" : "Play"}
        title={state.playing ? "Pause" : "Play"}
        onPointerDown={press(() => {})}
        onClick={() => (state.playing ? dispatch({ type: "pause" }) : void playAll())}
      >
        {state.playing ? <IconPause /> : <IconPlay />}
      </button>
      <button type="button" className="hud-btn" aria-label="Next track" title="Next" onPointerDown={press(() => {})} onClick={() => dispatch({ type: "next" })}>
        <IconNext />
      </button>
      <button
        type="button"
        className={`hud-btn${state.repeat === "off" ? "" : " on"}`}
        aria-label={`Repeat: ${state.repeat}`}
        title={`Repeat: ${state.repeat}`}
        onClick={() => dispatch({ type: "repeat", mode: state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off" })}
      >
        <IconRepeat />
        {state.repeat === "one" && <sup>1</sup>}
      </button>
    </div>
  );
}

function Timeline({ player }: { player: Player }) {
  const { state, dispatch } = player;
  const pct = state.duration > 0 ? (state.position / state.duration) * 100 : 0;
  return (
    <div className="hud-timeline">
      <span className="hud-time">{clock(state.position)}</span>
      <input
        type="range"
        className="hud-range"
        aria-label="Position"
        min={0}
        max={Math.max(1, Math.floor(state.duration))}
        step={1}
        value={Math.min(Math.floor(state.position), Math.max(1, Math.floor(state.duration)))}
        style={{ ["--fill" as string]: `${pct}%` }}
        disabled={state.duration <= 0}
        onChange={(e) => dispatch({ type: "seek", seconds: Number(e.target.value) })}
      />
      <span className="hud-time">-{clock(Math.max(0, state.duration - state.position))}</span>
    </div>
  );
}

function VolumeControl({ player }: { player: Player }) {
  const { state, dispatch } = player;
  return (
    <div className="hud-volume">
      <button type="button" className="hud-btn" aria-label={state.muted ? "Unmute" : "Mute"} onClick={() => dispatch({ type: "mute" })}>
        {state.muted || state.volume === 0 ? <IconMute /> : <IconVolume />}
      </button>
      <input
        type="range"
        className="hud-range"
        aria-label="Volume"
        min={0}
        max={100}
        value={state.muted ? 0 : state.volume}
        style={{ ["--fill" as string]: `${state.muted ? 0 : state.volume}%` }}
        onChange={(e) => dispatch({ type: "volume", level: Number(e.target.value) })}
      />
    </div>
  );
}

/** The queue and the library, as stacked angled tabs. */
function Playlist({ player, anim }: { player: Player; anim: Anim }) {
  const { state, dispatch } = player;
  const [tab, setTab] = useState<"queue" | "library">(state.queue.length ? "queue" : "library");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ tracks: Row[]; total: number } | null>(null);
  useEffect(() => {
    if (tab !== "library") return;
    let live = true;
    const t = setTimeout(() => void fetchLibrary(q, 100).then((r) => live && setFound(r)), q ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [tab, q]);
  const rows: { track: Track; index: number }[] = tab === "queue" ? state.queue.map((track, index) => ({ track, index })) : (found?.tracks ?? []).map((r, index) => ({ track: asTrack(r), index }));
  return (
    <div className="hud-playlist">
      <div className="hud-tabs" role="tablist">
        {(["queue", "library"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`hud-chip${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
            {t === "queue" ? `Queue (${state.queue.length})` : "Library"}
          </button>
        ))}
        {tab === "queue" && state.queue.length > 0 && (
          <button type="button" className="hud-chip" onClick={() => dispatch({ type: "clear" })}>
            Clear
          </button>
        )}
      </div>
      {tab === "library" && <input className="hud-search" type="search" placeholder="Search title, artist or album" aria-label="Search the music" value={q} onChange={(e) => setQ(e.target.value)} />}
      <ul className="hud-list">
        {rows.length === 0 && <li className="hud-empty">{tab === "queue" ? "The queue is empty." : found ? "No music matches." : "Loading…"}</li>}
        {rows.map(({ track, index }, i) => {
          const current = tab === "queue" && index === state.index;
          return (
            <li key={`${track.id}-${index}`} className={`hud-tab hud-cut${current ? " current" : ""}${anim === "full" ? " hud-boot" : ""}`} style={{ ["--i" as string]: Math.min(i, 12) }}>
              <button
                type="button"
                className="hud-tab-main"
                aria-current={current ? "true" : undefined}
                onPointerDown={anim === "off" ? undefined : ripple}
                onClick={() => (tab === "queue" ? dispatch({ type: "jump", index }) : dispatch({ type: "play", tracks: (found?.tracks ?? []).map(asTrack), mode: "replace", start: index }))}
              >
                <span className="hud-tab-title">{track.title}</span>
                <small>{track.artist || track.album}</small>
              </button>
              {tab === "library" && (
                <button type="button" className="hud-mini" aria-label={`Add ${track.title} to the queue`} title="Add to the queue" onClick={() => dispatch({ type: "play", tracks: [track], mode: "add" })}>
                  +
                </button>
              )}
              {tab === "queue" && (
                <button type="button" className="hud-mini" aria-label={`Remove ${track.title} from the queue`} title="Remove" onClick={() => dispatch({ type: "remove", index })}>
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The music player in the S.H.I.E.L.D.-style HUD: a bar (mini) with the timeline, the three angled buttons and the dial, and a full
 * view with the big dial, level bars, volume and the playlist. The assistant controls the same player.
 */
export function MusicPlayerView({ player, music, animations }: { player: Player; music: MusicView | null; animations: Anim }) {
  const { state, dispatch, current, blocked, analyser, unlock } = player;
  const levels = useMemo(newLevels, []);
  const cover = useCover(current?.id);
  const full = state.view === "full";
  const title = useScramble(current?.title ?? "", animations === "full");
  if (!music?.folderSet || state.view === "hidden") return null;
  const progress = state.duration > 0 ? state.position / state.duration : 0;
  const animate = animations !== "off";

  return (
    <Movable id="music" label="Music player" wholeBox testId="music" className={`hud hud-music hud-cut ${full ? "full" : "mini"}${state.playing ? " playing" : ""}${animations === "full" ? " hud-boot" : ""}`}>
      <header className="hud-music-head">
        <span className="hud-kicker">Media player</span>
        <span className="hud-head-actions">
          <button type="button" className="hud-btn" aria-label={full ? "Smaller player" : "Bigger player"} title={full ? "Smaller" : "Bigger"} onClick={() => dispatch({ type: "view", view: full ? "mini" : "full" })}>
            {full ? <IconCollapse /> : <IconExpand />}
          </button>
          <button type="button" className="hud-btn" aria-label="Hide the player" title="Hide (the music keeps playing)" onClick={() => dispatch({ type: "view", view: "hidden" })}>
            <IconClose />
          </button>
        </span>
      </header>

      <div className="hud-music-body">
        <div className="hud-music-left">
          {full && <LevelBars levels={levels} animate={animate} side="left" />}
          <Dial progress={progress} playing={state.playing} cover={cover} analyser={analyser} levels={levels} visualizer={music.visualizer} animate={animate} size={full ? 250 : 112} />
          {full && <LevelBars levels={levels} animate={animate} side="right" />}
        </div>
        <div className="hud-music-main">
          <div className="hud-now" aria-live="polite">
            <b className="hud-title">{current ? title : "Nothing playing"}</b>
            <small className="hud-sub">{current ? [current.artist, current.album].filter(Boolean).join(" — ") : "Press play, or ask for some music."}</small>
          </div>
          <Timeline player={player} />
          <Transport player={player} anim={animations} />
          {full && <VolumeControl player={player} />}
          {blocked && (
            <button type="button" className="hud-unlock" onClick={unlock}>
              Tap to enable sound
            </button>
          )}
        </div>
        {full && <Playlist player={player} anim={animations} />}
      </div>
    </Movable>
  );
}
