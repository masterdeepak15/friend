import type { ClientMsg, MusicState } from "@friend/protocol";
import { actionToCommand } from "@friend/protocol";
import { useCallback, useMemo } from "react";
import type { PlayerAction, PlayerState, Track } from "./playerCore";
import type { MusicPlayer } from "./useMusicPlayer";

/** What the PC's player said, as the screen's player state. The view (mini, full, hidden) is the screen's own. */
function fromHost(host: MusicState | null, view: PlayerState["view"]): { state: PlayerState; current: Track | null } {
  if (!host) return { state: { queue: [], index: -1, playing: false, position: 0, duration: 0, volume: 70, muted: false, shuffle: false, repeat: "all", view }, current: null };
  const queue: Track[] = host.queue.map((q, i) => (i === host.index ? { id: q.id, title: host.title || q.title, artist: host.artist, album: host.album, durationSec: host.duration > 0 ? host.duration : null } : { id: q.id, title: q.title, artist: "", album: "", durationSec: null }));
  const state: PlayerState = { queue, index: host.index, playing: host.playing, position: host.position, duration: host.duration, volume: host.volume, muted: host.muted, shuffle: host.shuffle, repeat: host.repeat, view };
  return { state, current: host.index >= 0 ? (queue[host.index] ?? null) : null };
}

/**
 * The player when the PC plays the music: it shows what the PC's player reports and turns every button into a command for it. It
 * has no audio of its own. Only the view (mini, full or hidden) stays a matter for this screen.
 */
export function useRemoteMusic({ local, host, send }: { local: MusicPlayer; host: MusicState | null; send: (m: ClientMsg) => void }): MusicPlayer {
  const view = local.state.view;
  const { state, current } = useMemo(() => fromHost(host, view), [host, view]);
  const localDispatch = local.dispatch;
  const dispatch = useCallback(
    (a: PlayerAction) => {
      if (a.type === "view") return localDispatch(a);
      const command = actionToCommand(a);
      if (command) send({ type: "music.remote", command });
    },
    [localDispatch, send],
  );
  return useMemo(() => ({ ...local, remote: true, state, dispatch, current, blocked: false, notice: null, analyser: null, unlock: () => {} }), [local, state, dispatch, current]);
}
