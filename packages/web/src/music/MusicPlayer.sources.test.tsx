import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MusicPlayerView } from "./MusicPlayer";
import { initialPlayer, type PlayerState, type Track } from "./playerCore";
import type { MusicPlayer } from "./useMusicPlayer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const t = (id: string, title: string): Track => ({ id, title, artist: "Artist", album: "Album", durationSec: 100 });
const music = { folderSet: true, volume: 70, shuffle: false, repeat: "all" as const, visualizer: false, startView: "full" as const };

function player(over: Partial<PlayerState> = {}, extra: Record<string, unknown> = {}): MusicPlayer {
  const state: PlayerState = { ...initialPlayer({ volume: 70, shuffle: false, repeat: "all", view: "full" }), ...over };
  return { state, dispatch: vi.fn(), current: state.index >= 0 ? (state.queue[state.index] ?? null) : null, blocked: false, notice: null, analyser: null, unlock: vi.fn(), audio: { current: null }, ...extra } as unknown as MusicPlayer;
}

const sources = (spotify: { connected: boolean; needs?: string | null }) => ({ sources: [{ id: "local", status: { connected: true, needs: null, account: null } }, { id: "spotify", status: { connected: spotify.connected, needs: spotify.needs ?? null, account: "me" } }], spotify: { redirectUri: "x", clientId: "abc" } });
function stubFetch(spotify: { connected: boolean; needs?: string | null }, hits: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      hits.push(String(url));
      if (String(url).startsWith("/api/music/sources")) return new Response(JSON.stringify(sources(spotify)));
      if (String(url).startsWith("/api/music/search")) return new Response(JSON.stringify({ tracks: [{ ref: "spotify:4uLU6hMCjMI75M1A2tKUQC", source: "spotify", title: "Never Gonna Give You Up", artist: "Rick Astley", album: "WNYSB", durationSec: 213 }], notes: [] }));
      if (String(url).startsWith("/api/music/library")) return new Response(JSON.stringify({ tracks: [{ id: "0000000000000001", title: "Folder Song", artist: "A", album: "B", durationSec: 90, cover: false }], total: 1 }));
      return new Response("{}", { status: 404 });
    }),
  );
}

describe("sources in the player", () => {
  it("tags a Spotify track in the queue and in the title area", async () => {
    stubFetch({ connected: true });
    render(<MusicPlayerView player={player({ queue: [t("spotify:4uLU6hMCjMI75M1A2tKUQC", "Never Gonna Give You Up"), t("0000000000000001", "Folder Song")], index: 0 })} music={music} animations="off" />);
    expect((await screen.findAllByText("SPOTIFY")).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryAllByText("SPOTIFY").length).toBeLessThanOrEqual(3);
  });

  it("shows a Spotify choice in the library only when Spotify is connected", async () => {
    stubFetch({ connected: false, needs: "Connect your Spotify account in Plugins, Spotify." });
    const { unmount } = render(<MusicPlayerView player={player()} music={music} animations="off" />);
    await userEvent.click(await screen.findByRole("tab", { name: "Library" }));
    await screen.findByText("Folder Song");
    expect(screen.queryByRole("tab", { name: "Spotify" })).toBeNull();
    unmount();
    stubFetch({ connected: true });
    render(<MusicPlayerView player={player()} music={music} animations="off" />);
    await userEvent.click(await screen.findByRole("tab", { name: "Library" }));
    expect(await screen.findByRole("tab", { name: "Spotify" })).toBeTruthy();
  });

  it("searches Spotify from the library and plays what is found by its ref", async () => {
    const hits: string[] = [];
    stubFetch({ connected: true }, hits);
    const p = player();
    render(<MusicPlayerView player={p} music={music} animations="off" />);
    await userEvent.click(await screen.findByRole("tab", { name: "Library" }));
    await userEvent.click(await screen.findByRole("tab", { name: "Spotify" }));
    await userEvent.type(screen.getByLabelText(/search/i), "never");
    await userEvent.click(await screen.findByRole("button", { name: /^Never Gonna Give You Up/ }));
    expect(hits.some((h) => h.startsWith("/api/music/search?") && h.includes("source=spotify") && h.includes("q=never"))).toBe(true);
    await waitFor(() => expect(p.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "play", mode: "replace", tracks: [expect.objectContaining({ id: "spotify:4uLU6hMCjMI75M1A2tKUQC" })] })));
  });

  it("asks for a word before searching Spotify, and a free account is told plainly", async () => {
    stubFetch({ connected: true, needs: "Spotify Premium is needed to play (searching works)." });
    render(<MusicPlayerView player={player()} music={music} animations="off" />);
    await userEvent.click(await screen.findByRole("tab", { name: "Library" }));
    await userEvent.click(await screen.findByRole("tab", { name: "Spotify" }));
    expect(screen.getByText(/Type to search Spotify/i)).toBeTruthy();
    expect(screen.getByText(/Premium is needed to play/)).toBeTruthy();
  });

  it("shows why the sound cannot start", async () => {
    stubFetch({ connected: true });
    render(<MusicPlayerView player={player({}, { notice: "Spotify Premium is needed to play on this screen." })} music={music} animations="off" />);
    expect((await screen.findByRole("status")).textContent).toMatch(/Premium is needed/);
  });
});
