import { AUDIO_EXTENSIONS, LAUNCHER_MUSIC, LAUNCHER_PANELS, MAX_LAUNCHER, MUSIC_LIMITS, launcherProblem, programProblem } from "@friend/protocol";
import { useState } from "react";
import type { HudSettings, MusicSettings } from "./settingsApi";

/** Where mpv is on the PC that runs Friend, or how to install it. */
export type HostCheck = { found: true; path: string; version: string } | { found: false; install: string };
export const httpHostCheck = async (): Promise<HostCheck> => {
  const res = await fetch("/api/music/host/check", { cache: "no-store" });
  if (!res.ok) throw new Error(res.status === 401 ? "Please sign in again." : `The request failed (${res.status}).`);
  return (await res.json()) as HostCheck;
};

type Item = HudSettings["launcher"][number];
type ActionType = Item["action"]["type"];
const ACTION_NOTE: Record<ActionType, string> = { url: "Open an address", prompt: "Ask the assistant", panel: "Open a panel", music: "Control the music" };
const defaultValue = (type: ActionType): string => (type === "panel" ? LAUNCHER_PANELS[0] : type === "music" ? LAUNCHER_MUSIC[0] : "");

/**
 * The music player and the screen widgets: where the music is, how it starts, how the date and time are written, what the
 * quick-launch buttons do and how much the screen may move. Saved with the owner's PIN like every other setting.
 */
export function WidgetsTab({ music, hud, onMusic, onHud, checkHost = httpHostCheck }: { music: MusicSettings; hud: HudSettings; onMusic: (p: Partial<MusicSettings>) => void; onHud: (p: Partial<HudSettings>) => void; checkHost?: () => Promise<HostCheck> }) {
  const [hostNote, setHostNote] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const runCheck = () => {
    setChecking(true);
    setHostNote(null);
    checkHost()
      .then((r) => setHostNote(r.found ? `mpv ${r.version} found (${r.path}).` : r.install))
      .catch((e: Error) => setHostNote(e.message))
      .finally(() => setChecking(false));
  };
  const launcher = hud.launcher;
  const setItem = (i: number, p: Partial<Item>) => onHud({ launcher: launcher.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= launcher.length) return;
    const next = [...launcher];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onHud({ launcher: next });
  };
  return (
    <div className="settings-section">
      <h3>Music player</h3>
      <label className="settings-field">
        <span>Music folder</span>
        <input type="text" value={music.folder} placeholder="C:\Users\you\Music" onChange={(e) => onMusic({ folder: e.target.value })} />
        <small className="auth-note">A folder on the PC that runs Friend. Its sub-folders are searched too. Saving checks that it exists.</small>
      </label>
      <fieldset className="settings-field">
        <span>File types to look for</span>
        {AUDIO_EXTENSIONS.map((ext) => (
          <label key={ext} className="settings-check">
            <input
              type="checkbox"
              checked={music.extensions.includes(ext)}
              onChange={(e) => {
                const next = e.target.checked ? [...music.extensions, ext] : music.extensions.filter((x) => x !== ext);
                if (next.length) onMusic({ extensions: AUDIO_EXTENSIONS.filter((x) => next.includes(x)) });
              }}
            />
            <span>{ext}</span>
          </label>
        ))}
      </fieldset>
      <label className="settings-field">
        <span>Start volume ({music.volume}%)</span>
        <input type="range" min={MUSIC_LIMITS.volume.min} max={MUSIC_LIMITS.volume.max} value={music.volume} onChange={(e) => onMusic({ volume: Number(e.target.value) })} />
      </label>
      <label className="settings-field">
        <span>Repeat</span>
        <select value={music.repeat} onChange={(e) => onMusic({ repeat: e.target.value as MusicSettings["repeat"] })}>
          <option value="off">Off</option>
          <option value="all">The whole list</option>
          <option value="one">One track</option>
        </select>
      </label>
      <label className="settings-field">
        <span>Starts as</span>
        <select value={music.startView} onChange={(e) => onMusic({ startView: e.target.value as MusicSettings["startView"] })}>
          <option value="mini">Small player</option>
          <option value="full">Big player with the playlist</option>
        </select>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={music.shuffle} onChange={(e) => onMusic({ shuffle: e.target.checked })} />
        <span>Shuffle</span>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={music.visualizer} onChange={(e) => onMusic({ visualizer: e.target.checked })} />
        <span>Moving bars around the dial</span>
      </label>
      <label className="settings-field">
        <span>Where music comes from, when the assistant is not told</span>
        <select value={music.defaultSource} onChange={(e) => onMusic({ defaultSource: e.target.value as MusicSettings["defaultSource"] })}>
          <option value="local">The music folder</option>
          <option value="spotify">Spotify</option>
          <option value="soundcloud">SoundCloud</option>
          <option value="audius">Audius</option>
          <option value="any">All</option>
        </select>
        <small className="auth-note">Spotify, SoundCloud and Audius are added from Plugins. Playing from Spotify needs Spotify Premium on your account.</small>
      </label>
      <label className="settings-field">
        <span>Most results from a service such as Spotify</span>
        <input type="number" min={MUSIC_LIMITS.searchLimit.min} max={MUSIC_LIMITS.searchLimit.max} value={music.searchLimit} onChange={(e) => onMusic({ searchLimit: Number(e.target.value) })} />
      </label>
      <label className="settings-field">
        <span>Where the sound comes out</span>
        <select value={music.output} onChange={(e) => onMusic({ output: e.target.value as MusicSettings["output"] })}>
          <option value="screen">The screen (the browser plays it)</option>
          <option value="host">This PC's speakers (no browser needed)</option>
        </select>
        <small className="auth-note">The PC's speakers play your folder's music through mpv, a free player you install once. Spotify plays on a Spotify device you name below.</small>
      </label>
      <label className="settings-field">
        <span>Program that plays the folder's music on the PC (empty: find mpv automatically)</span>
        <input type="text" value={music.hostPlayer} maxLength={260} placeholder="mpv" onChange={(e) => onMusic({ hostPlayer: e.target.value })} />
        {programProblem(music.hostPlayer.trim()) && (
          <small role="alert" className="auth-error">
            {programProblem(music.hostPlayer.trim())}
          </small>
        )}
      </label>
      <div className="settings-field">
        <button type="button" disabled={checking} onClick={runCheck}>
          Check mpv
        </button>
        <small className="auth-note">Looks for mpv with the saved program setting, or automatically when it is empty.</small>
        {hostNote && (
          <small role="status" className="auth-note">
            {hostNote}
          </small>
        )}
      </div>
      <label className="settings-field">
        <span>Spotify device on the PC to play on</span>
        <input type="text" value={music.spotifyDevice} maxLength={100} placeholder="the name Spotify shows for that device" onChange={(e) => onMusic({ spotifyDevice: e.target.value })} />
      </label>
      <label className="settings-field">
        <span>Most tracks to list</span>
        <input type="number" min={MUSIC_LIMITS.maxTracks.min} max={MUSIC_LIMITS.maxTracks.max} value={music.maxTracks} onChange={(e) => onMusic({ maxTracks: Number(e.target.value) })} />
      </label>
      <label className="settings-field">
        <span>How many folders deep to search</span>
        <input type="number" min={MUSIC_LIMITS.scanDepth.min} max={MUSIC_LIMITS.scanDepth.max} value={music.scanDepth} onChange={(e) => onMusic({ scanDepth: Number(e.target.value) })} />
      </label>

      <h3>Screen widgets</h3>
      <label className="settings-field">
        <span>Name on the profile tag</span>
        <input type="text" maxLength={24} value={hud.terminalLabel} onChange={(e) => onHud({ terminalLabel: e.target.value })} />
      </label>
      <label className="settings-field">
        <span>Animations</span>
        <select value={hud.animations} onChange={(e) => onHud({ animations: e.target.value as HudSettings["animations"] })}>
          <option value="full">Full</option>
          <option value="reduced">Reduced (only answers to hover and press)</option>
          <option value="off">Off</option>
        </select>
        <small className="auth-note">If the device is set to reduce motion, the screen stays still whatever this says.</small>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={hud.clock.hour12} onChange={(e) => onHud({ clock: { ...hud.clock, hour12: e.target.checked } })} />
        <span>12-hour clock</span>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={hud.clock.seconds} onChange={(e) => onHud({ clock: { ...hud.clock, seconds: e.target.checked } })} />
        <span>Show seconds</span>
      </label>
      <label className="settings-field">
        <span>Date language (empty: the device's own)</span>
        <input type="text" value={hud.clock.locale} maxLength={35} placeholder="en-GB" onChange={(e) => onHud({ clock: { ...hud.clock, locale: e.target.value } })} />
      </label>

      <h3>Quick-launch buttons</h3>
      {launcher.length === 0 && <small className="auth-note">No buttons yet.</small>}
      {launcher.map((item, i) => {
        const problem = launcherProblem(item);
        return (
          <div key={item.id ?? i} className="settings-field" role="group" aria-label={`Button ${i + 1}`}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input type="text" aria-label="Icon" style={{ width: 56 }} value={item.icon} onChange={(e) => setItem(i, { icon: e.target.value })} />
              <input type="text" aria-label="Label" maxLength={24} style={{ flex: 1, minWidth: 100 }} value={item.label} onChange={(e) => setItem(i, { label: e.target.value })} />
              <select
                aria-label="What it does"
                value={item.action.type}
                onChange={(e) => {
                  const type = e.target.value as ActionType;
                  setItem(i, { action: { type, value: defaultValue(type) } });
                }}
              >
                {(Object.keys(ACTION_NOTE) as ActionType[]).map((t) => (
                  <option key={t} value={t}>
                    {ACTION_NOTE[t]}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {item.action.type === "panel" || item.action.type === "music" ? (
                <select aria-label="Which" style={{ flex: 1 }} value={item.action.value} onChange={(e) => setItem(i, { action: { ...item.action, value: e.target.value } })}>
                  {(item.action.type === "panel" ? LAUNCHER_PANELS : LAUNCHER_MUSIC).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  aria-label={item.action.type === "url" ? "Address" : "Question"}
                  style={{ flex: 1 }}
                  value={item.action.value}
                  placeholder={item.action.type === "url" ? "https://…" : "What should it ask?"}
                  onChange={(e) => setItem(i, { action: { ...item.action, value: e.target.value } })}
                />
              )}
              <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" aria-label="Move down" disabled={i === launcher.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button type="button" aria-label="Remove button" onClick={() => onHud({ launcher: launcher.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </div>
            {problem && (
              <small role="alert" className="auth-error">
                {problem}
              </small>
            )}
          </div>
        );
      })}
      <button type="button" disabled={launcher.length >= MAX_LAUNCHER} onClick={() => onHud({ launcher: [...launcher, { label: "New", icon: "+", action: { type: "panel", value: "chat" } }] })}>
        Add a button ({launcher.length}/{MAX_LAUNCHER})
      </button>
      <small className="auth-note">The assistant can never change the music folder, these buttons or the animations, even with your PIN.</small>
    </div>
  );
}
