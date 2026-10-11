import { describe, expect, it } from "vitest";
import { ClientMsg, MusicView, ServerMsg } from "./messages";

const state = { playing: true, trackId: "0000000000000001", title: "T", artist: "A", album: "B", position: 1, duration: 100, volume: 50, muted: false, shuffle: false, repeat: "all", view: "mini", queue: [{ id: "0000000000000001", title: "T" }], index: 0, active: true };

describe("the screen as a remote for the PC's player", () => {
  it("a screen can send a music command to the PC", () => {
    expect(ClientMsg.safeParse({ type: "music.remote", command: { action: "pause" } }).success).toBe(true);
    expect(ClientMsg.safeParse({ type: "music.remote", command: { action: "jump", index: 2 } }).success).toBe(true);
    expect(ClientMsg.safeParse({ type: "music.remote", command: { action: "explode" } }).success).toBe(false);
    expect(ClientMsg.safeParse({ type: "music.remote" }).success).toBe(false);
  });
  it("the server can tell every screen what the PC is playing", () => {
    expect(ServerMsg.safeParse({ type: "music.host", state }).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "music.host", state: { ...state, volume: 500 } }).success).toBe(false);
  });
  it("the screen is told which output is chosen", () => {
    const view = { folderSet: true, volume: 70, shuffle: false, repeat: "all", visualizer: true, startView: "mini" };
    expect(MusicView.safeParse(view).success).toBe(true);
    expect(MusicView.safeParse({ ...view, output: "host" }).success).toBe(true);
    expect(MusicView.safeParse({ ...view, output: "speaker" }).success).toBe(false);
  });
});
