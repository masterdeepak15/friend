import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";

export interface HelperInfo {
  found: boolean;
  version?: string;
  /** One sentence on how to install it, when it is missing. */
  install?: string;
}

export interface VideoSettingsView {
  output: "screen" | "host";
  maxHeight: number;
  maxMinutes: number;
  allowedSites: string[];
  ytdlp: string;
  ffmpeg: string;
  /** Friend downloads yt-dlp and ffmpeg itself when they are missing. */
  autoInstall: boolean;
  /** How a YouTube video plays on the screen. */
  youtube: "embed" | "stream";
}

export interface VideoInfo {
  settings: VideoSettingsView;
  status: { ytdlp: HelperInfo; ffmpeg: HelperInfo; mpv: HelperInfo; setup?: { busy: boolean; message: string | null; error: string | null } };
}

export interface VideoApi {
  info(): Promise<VideoInfo>;
  /** Looks for the helper programs again (the owner may have just installed one). */
  recheck(): Promise<VideoInfo["status"]>;
  /** Downloads what is missing (no PIN: it only fetches the programs, checked, into Friend's own folder), then looks again. */
  prepare(): Promise<VideoInfo["status"]>;
  /** Only the settings that changed. Needs the PIN. */
  save(patch: Record<string, unknown>, pin: string): Promise<void>;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("Could not reach Friend. Check the connection.");
  }
  let body: { error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* no JSON body */
  }
  if (!res.ok) throw new Error(body.error ?? (res.status === 401 ? "Please sign in again." : res.status === 403 ? "Incorrect PIN" : `The request failed (${res.status}).`));
  return body as T;
}

const EMPTY: VideoSettingsView = { output: "screen", maxHeight: 720, maxMinutes: 240, allowedSites: [], ytdlp: "", ffmpeg: "", autoInstall: true, youtube: "embed" };

export const httpVideoApi: VideoApi = {
  info: async () => {
    const [s, st] = await Promise.all([call<{ video?: VideoSettingsView }>("/api/settings"), call<VideoInfo["status"]>("/api/plugins/video/status")]);
    return { settings: s.video ?? EMPTY, status: st };
  },
  recheck: () => call<VideoInfo["status"]>("/api/plugins/video/check", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
  prepare: () => call<VideoInfo["status"]>("/api/plugins/video/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
  save: async (patch, pin) => {
    await call("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin, settings: { video: patch } }) });
  },
};

const QUALITIES = [360, 480, 720, 1080];
const MIN_MINUTES = 1;
const MAX_MINUTES = 600;

/** "a.com, b.com\nc.com ;" as a list: any mix of commas, semicolons, spaces and new lines. */
const parseSites = (text: string): string[] => text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
const sitesText = (list: string[]): string => list.join(", ");

function HelperLine({ name, h, need, auto }: { name: string; h: HelperInfo; need: string; auto: string | null }) {
  return (
    <li className={h.found ? "done" : undefined}>
      {h.found ? (
        <>
          {name} {h.version ?? ""} found
        </>
      ) : (
        <>
          <strong>{name} not found</strong> <small>({need})</small>
          {auto && <div className="auth-note">{auto}</div>}
          {h.install && <div className="auth-note">{h.install}</div>}
        </>
      )}
    </li>
  );
}

/**
 * The Configure page of Web video: which helper programs are on this PC (and how to install the rest), and the owner's choices:
 * where videos play, how sharp, how long, which sites, and the program paths. Saved with the PIN; only what changed is sent.
 */
export function VideoForm({ api = httpVideoApi, pollMs = 2000 }: { api?: VideoApi; pollMs?: number }) {
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [draft, setDraft] = useState<VideoSettingsView>(EMPTY);
  const [sites, setSites] = useState("");
  const [minutes, setMinutes] = useState("240");
  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const i = await api.info();
      if (!alive.current) return;
      setInfo(i);
      setDraft(i.settings);
      setSites(sitesText(i.settings.allowedSites));
      setMinutes(String(i.settings.maxMinutes));
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // while Friend is downloading the programs, look again now and then so the page shows how far it is (and what is ready when it is done)
  const downloading = info?.status.setup?.busy === true;
  useEffect(() => {
    if (!downloading || pollMs <= 0) return;
    const timer = setInterval(() => {
      void api
        .info()
        .then((i) => alive.current && setInfo((cur) => (cur ? { ...cur, status: i.status } : i)))
        .catch(() => {});
    }, pollMs);
    return () => clearInterval(timer);
  }, [downloading, pollMs, api]);

  const saved = info?.settings ?? EMPTY;
  const minutesNumber = Number(minutes);
  const minutesProblem = !Number.isInteger(minutesNumber) || minutesNumber < MIN_MINUTES || minutesNumber > MAX_MINUTES ? `Use a whole number of minutes from ${MIN_MINUTES} to ${MAX_MINUTES}.` : null;

  const changes = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    if (draft.output !== saved.output) c.output = draft.output;
    if (draft.maxHeight !== saved.maxHeight) c.maxHeight = draft.maxHeight;
    if (!minutesProblem && minutesNumber !== saved.maxMinutes) c.maxMinutes = minutesNumber;
    const list = parseSites(sites);
    if (JSON.stringify(list) !== JSON.stringify(saved.allowedSites)) c.allowedSites = list;
    if (draft.autoInstall !== saved.autoInstall) c.autoInstall = draft.autoInstall;
    if (draft.youtube !== saved.youtube) c.youtube = draft.youtube;
    if (draft.ytdlp.trim() !== saved.ytdlp) c.ytdlp = draft.ytdlp.trim();
    if (draft.ffmpeg.trim() !== saved.ffmpeg) c.ffmpeg = draft.ffmpeg.trim();
    return c;
  };
  const patch = changes();
  const dirty = Object.keys(patch).length > 0;

  const recheck = async () => {
    setBusy(true);
    setError(null);
    try {
      const status = await api.recheck();
      if (alive.current) setInfo((i) => (i ? { ...i, status } : i));
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const prepare = async () => {
    setBusy(true);
    setError(null);
    try {
      const status = await api.prepare();
      if (alive.current) setInfo((i) => (i ? { ...i, status } : i));
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.save(patch, pin);
      if (!alive.current) return;
      setAsking(false);
      setNote("Saved.");
      await load();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) {
        setBusy(false);
        setPin("");
      }
    }
  };

  if (asking) {
    return (
      <>
        <p className="auth-note">Enter your PIN to save these changes.</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && pin.length >= 6 && void save()} />
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={() => void save()}>
            Save
          </button>
          <button
            type="button"
            style={touch}
            onClick={() => {
              setAsking(false);
              setPin("");
              setError(null);
            }}
          >
            Back
          </button>
        </div>
      </>
    );
  }

  const st = info?.status;
  const setup = st?.setup;
  const auto = (names: string): string | null => (draft.autoInstall ? `Friend downloads ${names} by itself when it is needed (or press Download now).` : null);
  const lacking = !!st && (!st.ytdlp.found || !st.ffmpeg.found);
  return (
    <div className="settings-section">
      {st && (
        <>
          <h4 className="plugins-heading">Helper programs on this PC</h4>
          <ol className="integration-steps">
            <HelperLine name="yt-dlp" h={st.ytdlp} need="finds the video, needed for every video" auto={auto("it")} />
            <HelperLine name="ffmpeg" h={st.ffmpeg} need="makes the video playable, needed for the Friend screen" auto={auto("it")} />
            <HelperLine name="mpv" h={st.mpv} need="optional: a window of its own on this PC; without it a browser window is used" auto={null} />
          </ol>
          {setup?.busy && <p className="auth-note">{setup.message ?? "Setting up the video tools…"}</p>}
          {!setup?.busy && setup?.error && (
            <p role="alert" className="auth-error">
              {setup.error}
            </p>
          )}
          <div className="approval-actions">
            {lacking && draft.autoInstall && !setup?.busy && (
              <button type="button" style={touch} className="primary" disabled={busy} onClick={() => void prepare()}>
                Download now
              </button>
            )}
            <button type="button" style={touch} disabled={busy} onClick={() => void recheck()}>
              Check again
            </button>
          </div>
        </>
      )}
      <label className="settings-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={draft.autoInstall} onChange={(e) => setDraft({ ...draft, autoInstall: e.target.checked })} />
        <span>Let Friend download yt-dlp and ffmpeg by itself (recommended)</span>
      </label>
      <label className="settings-field">
        <span>Where videos play</span>
        <select value={draft.output} onChange={(e) => setDraft({ ...draft, output: e.target.value as "screen" | "host" })}>
          <option value="screen">On the Friend screen</option>
          <option value="host">In a window on this PC</option>
        </select>
      </label>
      <label className="settings-field">
        <span>YouTube plays with</span>
        <select value={draft.youtube} onChange={(e) => setDraft({ ...draft, youtube: e.target.value as "embed" | "stream" })}>
          <option value="embed">YouTube's own player (recommended: nothing to download)</option>
          <option value="stream">Friend's player (made by Friend with ffmpeg)</option>
        </select>
      </label>
      <label className="settings-field">
        <span>Picture quality (the tallest picture)</span>
        <select value={String(draft.maxHeight)} onChange={(e) => setDraft({ ...draft, maxHeight: Number(e.target.value) })}>
          {(QUALITIES.includes(draft.maxHeight) ? QUALITIES : [...QUALITIES, draft.maxHeight].sort((a, b) => a - b)).map((q) => (
            <option key={q} value={q}>
              {q}p
            </option>
          ))}
        </select>
      </label>
      <label className="settings-field">
        <span>Longest video, in minutes</span>
        <input type="number" min={MIN_MINUTES} max={MAX_MINUTES} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      </label>
      {minutesProblem && (
        <p role="alert" className="auth-error">
          {minutesProblem}
        </p>
      )}
      <label className="settings-field">
        <span>Allowed sites (empty: any public site)</span>
        <textarea rows={2} spellCheck={false} placeholder="youtube.com, vimeo.com" value={sites} onChange={(e) => setSites(e.target.value)} />
      </label>
      <label className="settings-field">
        <span>yt-dlp program (empty: find it by itself)</span>
        <input type="text" value={draft.ytdlp} maxLength={260} spellCheck={false} autoComplete="off" placeholder="yt-dlp" onChange={(e) => setDraft({ ...draft, ytdlp: e.target.value })} />
      </label>
      <label className="settings-field">
        <span>ffmpeg program (empty: find it by itself)</span>
        <input type="text" value={draft.ffmpeg} maxLength={260} spellCheck={false} autoComplete="off" placeholder="ffmpeg" onChange={(e) => setDraft({ ...draft, ffmpeg: e.target.value })} />
      </label>
      {note && !dirty && <p className="auth-note">{note}</p>}
      {error && !minutesProblem && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      <div className="approval-actions">
        <button type="button" style={touch} className="primary" disabled={!dirty || busy || minutesProblem !== null} onClick={() => setAsking(true)}>
          {dirty ? "Save…" : "Save"}
        </button>
      </div>
      <small className="auth-note">Friend downloads the two programs from their projects' own release pages (github.com), checks them against the published checksums and keeps them in its own folder, never anywhere else on your PC. Videos stay on the site; nothing is saved to your disk. Some sites need a login or are not available in every country, and those cannot be played.</small>
    </div>
  );
}
