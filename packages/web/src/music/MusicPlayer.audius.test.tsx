import { cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationConfig } from "../plugins/IntegrationConfig";
import type { IntegrationEntry } from "../plugins/pluginsApi";
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
function stubFetch(audius: boolean, hits: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      hits.push(String(url));
      if (String(url).startsWith("/api/music/sources")) return new Response(JSON.stringify({ sources: [{ id: "local", status: status(true) }, { id: "audius", status: status(audius, audius ? null : "Install and switch on Audius in Plugins.") }] }));
      if (String(url).startsWith("/api/music/search")) return new Response(JSON.stringify({ tracks: [{ ref: "audius:95wro", source: "audius", title: "Stars In The Sky", artist: "Lofi Army", album: "", durationSec: 71 }] }));
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

describe("Audius in the player", () => {
  it("tags an Audius track", async () => {
    stubFetch(true);
    render(<MusicPlayerView player={player({ queue: [t("audius:95wro", "Stars In The Sky"), t("0000000000000001", "Folder Song")], index: 0 })} music={music} animations="off" />);
    expect((await screen.findAllByText("AUDIUS")).length).toBeGreaterThanOrEqual(2);
  });

  it("offers an Audius choice in the library only when it is on, and searches it", async () => {
    const hits: string[] = [];
    stubFetch(false);
    const { unmount } = render(<MusicPlayerView player={player()} music={music} animations="off" />);
    await userEvent.click(await screen.findByRole("tab", { name: "Library" }));
    await screen.findByText("Folder Song");
    expect(screen.queryByRole("tab", { name: "Audius" })).toBeNull();
    unmount();
    stubFetch(true, hits);
    render(<MusicPlayerView player={player()} music={music} animations="off" />);
    await userEvent.click(await screen.findByRole("tab", { name: "Library" }));
    await userEvent.click(await screen.findByRole("tab", { name: "Audius" }));
    await userEvent.type(screen.getByRole("searchbox"), "stars");
    expect(await screen.findByText("Stars In The Sky")).toBeTruthy();
    expect(hits.some((h) => h.includes("/api/music/search") && h.includes("source=audius"))).toBe(true);
  });
});

describe("playing an Audius track on the screen", () => {
  it("loads the audio from Friend's stream route", () => {
    const audio = new Audio();
    const createSpotify = vi.fn(() => new Audio());
    renderHook(() => useMusicPlayer({ music, cmd: { n: 1, command: { action: "play", tracks: [{ id: "audius:95wro", title: "Stars", artist: "L", album: "", durationSec: 71 }], mode: "replace" } }, send: () => {}, connection: "open", createAudio: () => audio, createSpotify }));
    expect(audio.src).toBe("/api/music/stream/audius:95wro");
    expect(createSpotify).not.toHaveBeenCalled();
  });
});

describe("the Audius plugin page", () => {
  it("has nothing to fill in and no Save button, only the steps", async () => {
    const entry: IntegrationEntry = { id: "audius", name: "Audius", description: "x", installed: true, enabled: false, state: "off", detail: "Switched off.", steps: [{ text: "Install it. There is nothing to sign in to and nothing to pay.", done: true }, { text: "Switch the plugin on.", done: false }] };
    const settingsApi = { get: vi.fn(async () => ({}) as never), save: vi.fn() };
    render(<IntegrationConfig integration={entry} onBack={() => {}} settingsApi={settingsApi as never} />);
    expect(await screen.findByText(/nothing to sign in to/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^save…?$/i })).toBeNull();
    expect(screen.queryByLabelText(/token|sid|number/i)).toBeNull();
  });
});
