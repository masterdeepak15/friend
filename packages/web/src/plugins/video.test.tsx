import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Video } from "../objects/more";
import { IntegrationConfig } from "./IntegrationConfig";
import type { IntegrationEntry } from "./pluginsApi";
import { VideoForm, type VideoApi, type VideoInfo } from "./VideoForm";

afterEach(cleanup);

const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const found = (version: string) => ({ found: true, version });
const info = (over: Partial<VideoInfo> = {}): VideoInfo => ({
  settings: { output: "screen", maxHeight: 720, maxMinutes: 240, allowedSites: [], ytdlp: "", ffmpeg: "", autoInstall: true, youtube: "embed" },
  status: { ytdlp: found("2026.10.01"), ffmpeg: found("7.1"), mpv: found("0.39") },
  ...over,
});
const api = (i: VideoInfo = info()): VideoApi => ({
  info: vi.fn(async () => i),
  recheck: vi.fn(async () => i.status),
  prepare: vi.fn(async () => i.status),
  save: vi.fn(async () => {}),
});

describe("the Web video Configure page", () => {
  it("shows which of the three programs are found, with their versions", async () => {
    render(<VideoForm api={api()} />);
    expect(await screen.findByText(/yt-dlp 2026\.10\.01/)).toBeTruthy();
    expect(screen.getByText(/ffmpeg 7\.1/)).toBeTruthy();
    expect(screen.getByText(/mpv 0\.39/)).toBeTruthy();
  });

  it("says what is missing and how to install it, in the program's own sentence", async () => {
    const i = info({ status: { ytdlp: { found: false, install: "yt-dlp is not installed. Install it once with: winget install yt-dlp." }, ffmpeg: found("7.1"), mpv: { found: false, install: "mpv is not installed. Install it once with: winget install mpv." } } });
    render(<VideoForm api={api(i)} />);
    expect(await screen.findByText(/winget install yt-dlp/)).toBeTruthy();
    expect(screen.getByText(/winget install mpv/)).toBeTruthy();
    expect(screen.getAllByText(/not found/i).length).toBeGreaterThanOrEqual(2);
  });

  it("says the missing programs are downloaded by Friend itself, and offers to do it now, with no PIN", async () => {
    const missing = info({ status: { ytdlp: { found: false, install: "yt-dlp is not installed." }, ffmpeg: { found: false, install: "ffmpeg is not installed." }, mpv: found("0.39") } });
    const a = api(missing);
    (a.prepare as ReturnType<typeof vi.fn>).mockResolvedValueOnce(info().status);
    render(<VideoForm api={a} />);
    expect((await screen.findAllByText(/Friend downloads (it|them) by itself/i)).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /download now/i }));
    expect(await screen.findByText(/yt-dlp 2026\.10\.01/)).toBeTruthy();
    expect(a.prepare).toHaveBeenCalledTimes(1);
  });

  it("has nothing to download when everything is there", async () => {
    render(<VideoForm api={api()} />);
    await screen.findByText(/yt-dlp 2026/);
    expect(screen.queryByRole("button", { name: /download now/i })).toBeNull();
  });

  it("shows how far the download is, and looks again by itself until it is done", async () => {
    const busy = info({ status: { ytdlp: { found: false }, ffmpeg: { found: false }, mpv: found("0.39"), setup: { busy: true, message: "Downloading ffmpeg 40%…", error: null } } });
    const a = api(busy);
    let n = 0;
    (a.info as ReturnType<typeof vi.fn>).mockImplementation(async () => (n++ < 1 ? busy : info()));
    render(<VideoForm api={a} pollMs={20} />);
    expect(await screen.findByText(/Downloading ffmpeg 40%/)).toBeTruthy();
    expect(await screen.findByText(/yt-dlp 2026\.10\.01/)).toBeTruthy();
    expect(screen.queryByText(/Downloading ffmpeg/)).toBeNull();
  });

  it("shows why a download failed, and a button to try again", async () => {
    const failed = info({ status: { ytdlp: { found: false }, ffmpeg: found("7.1"), mpv: found("0.39"), setup: { busy: false, message: null, error: "Friend could not download yt-dlp. Check the internet connection and try again." } } });
    render(<VideoForm api={api(failed)} />);
    expect(await screen.findByText(/could not download yt-dlp/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /download now/i })).toBeTruthy();
  });

  it("says mpv is optional: without it a browser window is used", async () => {
    render(<VideoForm api={api(info({ status: { ytdlp: found("1"), ffmpeg: found("1"), mpv: { found: false, install: "mpv is not installed." } } }))} />);
    expect(await screen.findByText(/without it a browser window is used/i)).toBeTruthy();
  });

  it("lets the owner choose how YouTube plays: in YouTube's own player, or through Friend", async () => {
    const a = api();
    render(<VideoForm api={a} />);
    const pick = (await screen.findByLabelText(/youtube plays/i)) as HTMLSelectElement;
    expect(pick.value).toBe("embed");
    await userEvent.selectOptions(pick, "stream");
    await userEvent.click(screen.getByRole("button", { name: /^save/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(a.save).toHaveBeenCalledWith({ youtube: "stream" }, "123456"));
  });

  it("can turn the automatic download off, and on again, with the PIN like any setting", async () => {
    const a = api();
    render(<VideoForm api={a} />);
    const box = (await screen.findByLabelText(/download.*by itself/i)) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: /^save/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(a.save).toHaveBeenCalledWith({ autoInstall: false }, "123456"));
  });

  it("looks again on request, with no PIN, and shows the new answer", async () => {
    const missing = info({ status: { ytdlp: { found: false, install: "yt-dlp is not installed." }, ffmpeg: found("7.1"), mpv: found("0.39") } });
    const a = api(missing);
    (a.recheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce(info().status);
    render(<VideoForm api={a} />);
    await screen.findAllByText(/yt-dlp is not installed/);
    await userEvent.click(screen.getByRole("button", { name: /check again/i }));
    expect(await screen.findByText(/yt-dlp 2026\.10\.01/)).toBeTruthy();
    expect(a.recheck).toHaveBeenCalledTimes(1);
  });

  it("starts from what is saved, and cannot be saved until something changes", async () => {
    render(<VideoForm api={api(info({ settings: { output: "host", maxHeight: 480, maxMinutes: 90, allowedSites: ["youtube.com", "vimeo.com"], ytdlp: "C:/t/yt-dlp.exe", ffmpeg: "", autoInstall: true, youtube: "embed" } }))} />);
    expect((await screen.findByLabelText(/where videos play/i) as HTMLSelectElement).value).toBe("host");
    expect((screen.getByLabelText(/picture quality/i) as HTMLSelectElement).value).toBe("480");
    expect((screen.getByLabelText(/longest video/i) as HTMLInputElement).value).toBe("90");
    expect((screen.getByLabelText(/allowed sites/i) as HTMLTextAreaElement).value).toBe("youtube.com, vimeo.com");
    expect((screen.getByLabelText(/yt-dlp program/i) as HTMLInputElement).value).toBe("C:/t/yt-dlp.exe");
    expect((screen.getByRole("button", { name: /^save/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves only what was changed, with the PIN", async () => {
    const a = api();
    render(<VideoForm api={a} />);
    await userEvent.selectOptions(await screen.findByLabelText(/where videos play/i), "host");
    await userEvent.selectOptions(screen.getByLabelText(/picture quality/i), "480");
    await userEvent.click(screen.getByRole("button", { name: /^save/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(a.save).toHaveBeenCalledWith({ output: "host", maxHeight: 480 }, "123456"));
  });

  it("sends the allowed sites as a list, however they were separated, and an empty box as an empty list", async () => {
    const a = api(info({ settings: { output: "screen", maxHeight: 720, maxMinutes: 240, allowedSites: ["youtube.com"], ytdlp: "", ffmpeg: "", autoInstall: true, youtube: "embed" } }));
    render(<VideoForm api={a} />);
    const box = await screen.findByLabelText(/allowed sites/i);
    await userEvent.clear(box);
    await userEvent.type(box, "YouTube.com,  vimeo.com\ndailymotion.com ;");
    await userEvent.click(screen.getByRole("button", { name: /^save/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(a.save).toHaveBeenCalledWith({ allowedSites: ["YouTube.com", "vimeo.com", "dailymotion.com"] }, "123456"));
    const again = await screen.findByLabelText(/allowed sites/i); // the page was shown again after saving
    await userEvent.clear(again);
    await userEvent.click(screen.getByRole("button", { name: /^save/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(a.save).toHaveBeenLastCalledWith({ allowedSites: [] }, "123456"));
  });

  it("refuses a length that cannot be right before asking for the PIN", async () => {
    render(<VideoForm api={api()} />);
    const mins = await screen.findByLabelText(/longest video/i);
    await userEvent.clear(mins);
    await userEvent.type(mins, "0");
    expect(screen.getByRole("alert").textContent).toMatch(/1 to 600/);
    expect((screen.getByRole("button", { name: /^save/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a wrong PIN as an error and keeps the page", async () => {
    const a = api();
    (a.save as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Incorrect PIN"));
    render(<VideoForm api={a} />);
    await userEvent.selectOptions(await screen.findByLabelText(/where videos play/i), "host");
    await userEvent.click(screen.getByRole("button", { name: /^save/i }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Incorrect PIN/);
  });
});

describe("inside Configure", () => {
  const entry: IntegrationEntry = { id: "video", name: "Web video", description: "Play videos.", installed: true, enabled: true, state: "online", detail: "Ready.", steps: [{ text: "Install the helper programs once.", done: true }] };
  it("is the page for the video plugin, with no generic Save button of its own", async () => {
    render(<IntegrationConfig integration={entry} onBack={() => {}} settingsApi={{ get: async () => ({}) as never, save: vi.fn() as never }} videoApi={api()} />);
    expect(await screen.findByText(/yt-dlp 2026\.10\.01/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^save/i })).toHaveLength(1); // the form's own
  });
});

describe("YouTube's own player on the screen", () => {
  const ID = "dQw4w9WgXcQ";
  it("is a frame of YouTube's privacy-friendly player, by the video's id, that starts by itself and can go full screen", () => {
    const { container } = render(<Video props={{ title: "Rick", embed: ID }} />);
    const f = container.querySelector("iframe")!;
    const u = new URL(f.getAttribute("src")!);
    expect(u.origin + u.pathname).toBe(`https://www.youtube-nocookie.com/embed/${ID}`);
    expect(u.searchParams.get("autoplay")).toBe("1");
    expect(u.searchParams.get("rel")).toBe("0");
    expect(u.searchParams.has("start")).toBe(false);
    expect(f.getAttribute("allow")).toMatch(/autoplay/);
    expect(f.getAttribute("allow")).toMatch(/fullscreen/);
    expect(f.hasAttribute("allowfullscreen")).toBe(true);
    expect(f.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
    expect(f.getAttribute("title")).toBe("Rick");
    expect(container.querySelector("video")).toBeNull();
  });
  it("begins at the time it was asked to", () => {
    const { container } = render(<Video props={{ embed: ID, start: 95 }} />);
    expect(new URL(container.querySelector("iframe")!.getAttribute("src")!).searchParams.get("start")).toBe("95");
  });
  it("says it is loading until the frame has loaded", () => {
    const { container } = render(<Video props={{ embed: ID }} />);
    expect(screen.getByText(/loading the player/i)).toBeTruthy();
    fireEvent.load(container.querySelector("iframe")!);
    expect(screen.queryByText(/loading the player/i)).toBeNull();
  });
  it("is never made from anything but an id: no address, no odd characters", () => {
    for (const bad of ["https://www.youtube.com/embed/dQw4w9WgXcQ", "short", "dQw4w9WgXcQ\"><script>", "../../x"]) {
      const { container, unmount } = render(<Video props={{ embed: bad }} />);
      expect(container.querySelector("iframe"), bad).toBeNull();
      expect(screen.getByText(/not available/i)).toBeTruthy();
      unmount();
    }
  });
});

describe("a video on the screen", () => {
  const SRC = "/api/video/" + "a".repeat(32);
  it("plays from Friend's own video address, by itself, with its own buttons", () => {
    const { container } = render(<Video props={{ title: "Lofi Girl", src: SRC }} />);
    const v = container.querySelector("video")!;
    expect(v.getAttribute("src")).toBe(SRC);
    expect(v.hasAttribute("controls")).toBe(true);
    expect(v.autoplay).toBe(true);
    expect(screen.getByText(/preparing the video/i)).toBeTruthy();
  });
  it("stops saying it is preparing once the first picture is there", () => {
    const { container } = render(<Video props={{ src: SRC }} />);
    fireEvent(container.querySelector("video")!, new Event("loadeddata"));
    expect(screen.queryByText(/preparing the video/i)).toBeNull();
  });
  it("says so, in one sentence, when the video cannot be played, and shows no broken player", () => {
    const { container } = render(<Video props={{ src: SRC }} />);
    fireEvent(container.querySelector("video")!, new Event("error"));
    expect(screen.getByText(/could not be played/i)).toBeTruthy();
    expect(container.querySelector("video")).toBeNull();
  });
  it("still plays a file the owner approved, without starting by itself, and never from the web", () => {
    const file = "/api/media/" + "b".repeat(32);
    const a = render(<Video props={{ src: file }} />);
    expect(a.container.querySelector("video")!.autoplay).toBe(false);
    expect(screen.queryByText(/preparing the video/i)).toBeNull();
    a.unmount();
    const b = render(<Video props={{ src: "https://www.youtube.com/watch?v=x" }} />);
    expect(b.container.querySelector("video")).toBeNull();
    expect(screen.getByText(/not available/i)).toBeTruthy();
  });
});
