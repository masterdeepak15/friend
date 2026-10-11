import { cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MusicPlayerView } from "./MusicPlayer";
import { initialPlayer, type PlayerState, type Track } from "./playerCore";
import { useMusicPlayer, type MusicPlayer, type PlayerAudio } from "./useMusicPlayer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const t = (id: string, title: string): Track => ({ id, title, artist: "Artist", album: "", durationSec: 100 });
const music = { folderSet: true, volume: 70, shuffle: false, repeat: "all" as const, visualizer: false, startView: "full" as const };

function player(over: Partial<PlayerState> = {}): MusicPlayer {
  const state: PlayerState = { ...initialPlayer({ volume: 70, shuffle: false, repeat: "all", view: "full" }), ...over };
  return { state, dispatch: vi.fn(), current: state.index >= 0 ? (state.queue[state.index] ?? null) : null, blocked: false, notice: null, analyser: null, unlock: vi.fn(), audio: { current: null } } as unknown as MusicPlayer;
}

const status = (connected: boolean, needs: string | null = null) => ({ connected, needs, account: null });
function stubFetch(soundcloud: { connected: boolean; needs?: string | null }, hits: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      hits.push(String(url));
      if (String(url).startsWith("/api/music/sources")) return new Response(JSON.stringify({ sources: [{ id: "local", status: status(true) }, { id: "spotify", status: status(false, "Connect Spotify") }, { id: "soundcloud", status: status(soundcloud.connected, soundcloud.needs ?? null) }] }));
      if (String(url).startsWith("/api/music/search")) return new Response(JSON.stringify({ tracks: [{ ref: "soundcloud:1001", source: "soundcloud", title: "Midnight City", artist: "M83 Official", album: "", durationSec: 243 }] }));
      if (String(url).startsWith("/api/music/library")) return new Response(JSON.stringify({ tracks: [{ id: "0000000000000001", title: "Folder Song", artist: "A", album: "B", durationSec: 90, cover: false }], total: 1 }));
      return new Response("{}", { status: 404 });
    }),
  );
}

class Audio implements PlayerAudio {
  src = "";
  currentTime = 0;
  duration = NaN;
  volume = 1;
  muted = false;
  paused = true;
  preload = "";
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener() {}
  removeEventListener() {}
}

describe("SoundCloud in the player", () => {
  it("tags a SoundCloud track in the queue and in the title area", async () => {
    stubFetch({ connected: true });
    render(<MusicPlayerView player={player({ queue: [t("soundcloud:1001", "Midnight City"), t("0000000000000001", "Folder Song")], index: 0 })} music={music} animations="off" />);
    expect((await screen.findAllByText("SOUNDCLOUD")).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryAllByText("SPOTIFY")).toHaveLength(0);
  });

  it("offers a SoundCloud choice in the library only when it is connected, and searches it", async () => {
    const hits: string[] = [];
    stubFetch({ connected: false, needs: "Connect your SoundCloud account in Plugins, SoundCloud." });
    const { unmount } = render(<MusicPlayerView player={player()} music={music} animations="off" />);
    await userEvent.click(await screen.findByRole("tab", { name: "Library" }));
    await screen.findByText("Folder Song");
    expect(screen.queryByRole("tab", { name: "SoundCloud" })).toBeNull();
    unmount();
    stubFetch({ connected: true }, hits);
    render(<MusicPlayerView player={player()} music={music} animations="off" />);
    await userEvent.click(await screen.findByRole("tab", { name: "Library" }));
    await userEvent.click(await screen.findByRole("tab", { name: "SoundCloud" }));
    expect(await screen.findByText("Type to search SoundCloud.")).toBeTruthy();
    await userEvent.type(screen.getByRole("searchbox"), "midnight");
    expect(await screen.findByText("Midnight City")).toBeTruthy();
    expect(hits.some((h) => h.includes("/api/music/search") && h.includes("source=soundcloud"))).toBe(true);
  });
});

describe("playing a SoundCloud track on the screen", () => {
  it("loads the audio from Friend's stream route, not from SoundCloud and not as a Spotify track", () => {
    const audio = new Audio();
    const createSpotify = vi.fn(() => new Audio());
    renderHook(() => useMusicPlayer({ music, cmd: { n: 1, command: { action: "play", tracks: [{ id: "soundcloud:1001", title: "Midnight City", artist: "M83", album: "", durationSec: 243 }], mode: "replace" } }, send: () => {}, connection: "open", createAudio: () => audio, createSpotify }));
    expect(audio.src).toBe("/api/music/stream/soundcloud:1001");
    expect(createSpotify).not.toHaveBeenCalled();
  });
});
