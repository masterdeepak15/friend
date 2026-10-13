import { useEffect, useMemo, useRef, useState } from "react";
import { sanitizeMarkdown } from "../stage/sanitize";

type Props = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Props => (typeof v === "object" && v !== null ? (v as Props) : {});

/** The only place a picture, clip or document may come from: a file the owner approved through file.present. */
export const MEDIA_SRC = /^\/api\/media\/[0-9a-f]{32}$/;
const safeSrc = (v: unknown): string | null => (typeof v === "string" && MEDIA_SRC.test(v) ? v : null);
/** A video from the internet is played through Friend: an address Friend made, never the site's own. Only a video card may use it. */
export const VIDEO_SRC = /^\/api\/video\/[0-9a-f]{32}$/;
const webVideoSrc = (v: unknown): string | null => (typeof v === "string" && VIDEO_SRC.test(v) ? v : null);

const Title = ({ props }: { props: Props }) => (str(props.title) ? <h3 className="obj-title">{str(props.title)}</h3> : null);

export function Markdown({ props }: { props: Props }) {
  const html = useMemo(() => sanitizeMarkdown(str(props.text)), [props.text]);
  return (
    <>
      <Title props={props} />
      <div className="obj-md obj-doc" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

export function Progress({ props }: { props: Props }) {
  const value = Math.min(100, Math.max(0, Number(props.value) || 0));
  return (
    <div className="obj-progress">
      <div className="obj-progress-head">
        <span className="obj-label">{str(props.label)}</span>
        <span className="obj-progress-pct">{Math.round(value)}%</span>
      </div>
      <div className="obj-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} aria-label={str(props.label) || "Progress"}>
        <i style={{ width: `${value}%` }} />
      </div>
      {str(props.detail) && <span className="obj-progress-detail">{str(props.detail)}</span>}
    </div>
  );
}

export function Checklist({ props }: { props: Props }) {
  const items = arr(props.items).map((it) => rec(typeof it === "object" && it !== null ? it : { text: it }));
  const done = items.filter((i) => i.done === true).length;
  return (
    <>
      <Title props={props} />
      <ul className="obj-checklist">
        {items.map((it, i) => (
          <li key={i} className={it.done === true ? "done" : undefined}>
            <span className="box" aria-hidden="true">{it.done === true ? "✓" : ""}</span>
            <span>{str(it.text)}</span>
          </li>
        ))}
      </ul>
      {items.length > 0 && <small className="obj-progress-detail">{done} of {items.length} done</small>}
    </>
  );
}

export function Kv({ props }: { props: Props }) {
  return (
    <>
      <Title props={props} />
      <dl className="obj-kv">
        {arr(props.rows).map((r, i) => {
          const row = rec(r);
          return (
            <div key={i}>
              <dt>{str(row.key)}</dt>
              <dd>{str(row.value)}</dd>
            </div>
          );
        })}
      </dl>
    </>
  );
}

const two = (n: number) => String(Math.floor(n)).padStart(2, "0");
export function clockText(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${two(s / 3600)}:${two((s % 3600) / 60)}:${two(s % 60)}`;
}

export function Countdown({ props }: { props: Props }) {
  const target = useRef<number | null>(null);
  if (target.current === null) {
    const to = typeof props.to === "string" ? Date.parse(props.to) : NaN;
    const seconds = Number(props.seconds);
    target.current = Number.isFinite(to) ? to : Date.now() + (Number.isFinite(seconds) ? seconds : 0) * 1000;
  }
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = (target.current - now) / 1000;
  return (
    <div className={`obj-countdown${left <= 0 ? " done" : ""}`}>
      <span className="obj-label">{str(props.title) || str(props.label)}</span>
      <span className="obj-countdown-time" role="timer">{clockText(left)}</span>
    </div>
  );
}

export function Img({ props }: { props: Props }) {
  const src = safeSrc(props.src);
  return (
    <div className="obj-media">
      <Title props={props} />
      {src ? <img src={src} alt={str(props.title) || "Picture"} loading="lazy" /> : <p className="obj-empty">This picture is not available.</p>}
    </div>
  );
}

/** One clip. A web video starts by itself (the owner just asked for it), says it is being prepared until the first picture comes, and says so when it cannot be played. */
function VideoPlayer({ src, web, title }: { src: string; web: boolean; title: string }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">(web ? "loading" : "ready");
  if (state === "failed") return <p className="obj-empty">This video could not be played. Ask Friend to try again, or to play it in a window on the PC.</p>;
  return (
    <>
      <video src={src} controls playsInline autoPlay={web} preload={web ? "auto" : "metadata"} aria-label={title} onLoadedData={() => setState("ready")} onError={() => setState("failed")} />
      {web && state === "loading" && <p className="obj-empty">Preparing the video…</p>}
    </>
  );
}

/** YouTube's own player, by the video's id and nothing else: the id is checked here again, so no address or markup can get in. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function YoutubePlayer({ id, start, title }: { id: string; start: number; title: string }) {
  const [loaded, setLoaded] = useState(false);
  const q = new URLSearchParams({ autoplay: "1", rel: "0", playsinline: "1", modestbranding: "1" });
  if (start > 0) q.set("start", String(start));
  return (
    <>
      <iframe
        className="obj-youtube"
        src={`https://www.youtube-nocookie.com/embed/${id}?${q.toString()}`}
        title={title}
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={() => setLoaded(true)}
      />
      {!loaded && <p className="obj-empty">Loading the player…</p>}
    </>
  );
}

export function Video({ props }: { props: Props }) {
  if (props.embed !== undefined) {
    const id = typeof props.embed === "string" && YOUTUBE_ID.test(props.embed) ? props.embed : null;
    const start = typeof props.start === "number" && props.start > 0 && props.start <= 86400 ? Math.floor(props.start) : 0;
    return (
      <div className="obj-media obj-media-fill">
        <Title props={props} />
        {id ? <YoutubePlayer key={`${id}-${start}`} id={id} start={start} title={str(props.title) || "YouTube video"} /> : <p className="obj-empty">This clip is not available.</p>}
      </div>
    );
  }
  const web = webVideoSrc(props.src);
  const src = web ?? safeSrc(props.src);
  return (
    <div className="obj-media">
      <Title props={props} />
      {src ? <VideoPlayer key={src} src={src} web={web !== null} title={str(props.title) || "Video"} /> : <p className="obj-empty">This clip is not available.</p>}
    </div>
  );
}

export function Pdf({ props }: { props: Props }) {
  const src = safeSrc(props.src);
  return (
    <div className="obj-media obj-pdf">
      <Title props={props} />
      {src ? (
        <>
          <iframe src={src} title={str(props.title) || "Document"} />
          <a className="obj-open" href={src} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
        </>
      ) : (
        <p className="obj-empty">This document is not available.</p>
      )}
    </div>
  );
}

export function Gallery({ props }: { props: Props }) {
  const items = arr(props.items).map(rec).filter((i) => safeSrc(i.src));
  const [at, setAt] = useState(0);
  const i = Math.min(at, Math.max(0, items.length - 1));
  const cur = items[i];
  if (!cur) return <p className="obj-empty">Nothing to show.</p>;
  const src = safeSrc(cur.src)!;
  const isVideo = cur.kind === "video";
  return (
    <div className="obj-media obj-gallery">
      <Title props={props} />
      {isVideo ? <video key={src} src={src} controls playsInline preload="metadata" /> : <img key={src} src={src} alt={str(cur.caption) || `Picture ${i + 1}`} />}
      <div className="obj-gallery-bar">
        <button type="button" aria-label="Previous" disabled={items.length < 2} onClick={() => setAt((i + items.length - 1) % items.length)}>‹</button>
        <span>{str(cur.caption)}<small>{i + 1} / {items.length}</small></span>
        <button type="button" aria-label="Next" disabled={items.length < 2} onClick={() => setAt((i + 1) % items.length)}>›</button>
      </div>
    </div>
  );
}
