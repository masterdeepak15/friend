import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandBar } from "../input/CommandBar";
import { ChatPanel } from "../layout/ChatPanel";
import { diffSettings, type AttachmentSettings, type SettingsView } from "../settings/settingsApi";
import { FILES_ONLY_TEXT, MAX_ATTACHED, uploadFile, useAttach, type Uploader } from "./useAttach";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const file = (name: string, body = "hello") => new File([body], name, { type: "text/plain" });
/** An uploader that answers when the test says so. */
function slowUploader() {
  const waiting: { file: File; ok: (id: string) => void; fail: (m: string) => void }[] = [];
  const upload: Uploader = (f) => new Promise((resolve, reject) => waiting.push({ file: f, ok: (id) => resolve({ id, name: f.name }), fail: (m) => reject(new Error(m)) }));
  return { upload, waiting };
}
const chooser = () => document.querySelector('input[type="file"]') as HTMLInputElement;

describe("uploading one file", () => {
  it("sends the raw file with its name, and gives back the id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "0123456789abcdef", name: "a.pdf", size: 3 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await uploadFile(file("my report.pdf"))).toEqual({ id: "0123456789abcdef", name: "a.pdf" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/chat/upload?name=my%20report.pdf");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/octet-stream");
  });
  it("turns the server's words into the error (the size limit, for one)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "That file is 12 MB; the limit is 10 MB." }), { status: 413 })));
    await expect(uploadFile(file("big.bin"))).rejects.toThrow("That file is 12 MB; the limit is 10 MB.");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 502 })));
    await expect(uploadFile(file("x"))).rejects.toThrow(/failed \(502\)/);
  });
});

describe("the files of one message", () => {
  it("uploads each file when it is chosen, is busy until it is done, and gives the ids of the ones that worked", async () => {
    const u = slowUploader();
    const { result } = renderHook(() => useAttach(u.upload));
    act(() => result.current.add([file("a.txt"), file("b.txt")]));
    expect(result.current.busy).toBe(true);
    expect(result.current.ready).toEqual([]);
    await act(async () => u.waiting[0]!.ok("aaaaaaaaaaaaaaaa"));
    await act(async () => u.waiting[1]!.fail("Too big"));
    expect(result.current.busy).toBe(false);
    expect(result.current.ready).toEqual([{ id: "aaaaaaaaaaaaaaaa", name: "a.txt" }]);
    expect(result.current.items[1]).toMatchObject({ state: "failed", error: "Too big" });
    act(() => result.current.remove(result.current.items[1]!.key));
    expect(result.current.items).toHaveLength(1);
    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
  });

  it("takes at most the number of files one message carries", () => {
    const u = slowUploader();
    const { result } = renderHook(() => useAttach(u.upload));
    act(() => result.current.add(Array.from({ length: MAX_ATTACHED + 4 }, (_, i) => file(`f${i}.txt`))));
    expect(result.current.items).toHaveLength(MAX_ATTACHED);
  });

  it("takes files dropped on it and pasted into it, but leaves a plain text paste alone", () => {
    const u = slowUploader();
    const { result } = renderHook(() => useAttach(u.upload));
    const dropped = { preventDefault: vi.fn(), dataTransfer: { files: [file("d.txt")], types: ["Files"] } };
    act(() => result.current.handlers.onDrop(dropped as never));
    expect(dropped.preventDefault).toHaveBeenCalled();
    expect(result.current.items).toHaveLength(1);
    const text = { preventDefault: vi.fn(), clipboardData: { files: [] } };
    act(() => result.current.handlers.onPaste(text as never));
    expect(text.preventDefault).not.toHaveBeenCalled();
    const pic = { preventDefault: vi.fn(), clipboardData: { files: [file("image.png")] } };
    act(() => result.current.handlers.onPaste(pic as never));
    expect(pic.preventDefault).toHaveBeenCalled();
    expect(result.current.items).toHaveLength(2);
    const over = { preventDefault: vi.fn(), dataTransfer: { types: ["Files"] } };
    result.current.handlers.onDragOver(over as never);
    expect(over.preventDefault).toHaveBeenCalled(); // so the drop is allowed
    const notFiles = { preventDefault: vi.fn(), dataTransfer: { types: ["text/plain"] } };
    result.current.handlers.onDragOver(notFiles as never);
    expect(notFiles.preventDefault).not.toHaveBeenCalled();
  });
});

function stubUpload(id = "0123456789abcdef") {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => new Response(JSON.stringify({ id, name: decodeURIComponent(String(url).split("name=")[1] ?? ""), size: (init.body as File).size }), { status: 200 })));
}

describe("the chat panel", () => {
  it("attaches a file, shows it, and sends the message with its id (and takes it off after)", async () => {
    stubUpload();
    const onSend = vi.fn();
    render(<ChatPanel lines={[]} live={false} onSend={onSend} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
    await userEvent.upload(chooser(), file("plan.md"));
    await waitFor(() => expect(screen.getByRole("list", { name: "Attached files" }).textContent).toContain("plan.md"));
    await userEvent.type(screen.getByLabelText("Type to chat"), "summarise it");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith("summarise it", [{ id: "0123456789abcdef", name: "plan.md" }]);
    expect(screen.queryByRole("list", { name: "Attached files" })).toBeNull();
  });

  it("sends the files alone, with a short line, when nothing is typed", async () => {
    stubUpload();
    const onSend = vi.fn();
    render(<ChatPanel lines={[]} live={false} onSend={onSend} onClose={() => {}} />);
    await userEvent.upload(chooser(), file("plan.md"));
    await waitFor(() => screen.getByRole("button", { name: "Remove plan.md" }));
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith(FILES_ONLY_TEXT, [{ id: "0123456789abcdef", name: "plan.md" }]);
  });

  it("waits for a file that is still uploading, and does not send a file that failed", async () => {
    const onSend = vi.fn();
    let finish!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (finish = r))));
    render(<ChatPanel lines={[]} live={false} onSend={onSend} onClose={() => {}} />);
    await userEvent.upload(chooser(), file("slow.txt"));
    await userEvent.type(screen.getByLabelText("Type to chat"), "go");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).not.toHaveBeenCalled(); // still on its way
    await act(async () => finish(new Response(JSON.stringify({ error: "That file is 12 MB; the limit is 10 MB." }), { status: 413 })));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/limit is 10 MB/));
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith("go"); // the failed file does not go
  });

  it("a message with no files is sent exactly as before, and an empty one is not sent", async () => {
    const onSend = vi.fn();
    render(<ChatPanel lines={[]} live={false} onSend={onSend} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Type to chat"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(onSend.mock.calls[0]).toHaveLength(1);
  });

  it("takes a file off before it is sent", async () => {
    stubUpload();
    const onSend = vi.fn();
    render(<ChatPanel lines={[]} live={false} onSend={onSend} onClose={() => {}} />);
    await userEvent.upload(chooser(), file("plan.md"));
    await waitFor(() => screen.getByRole("button", { name: "Remove plan.md" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove plan.md" }));
    await userEvent.type(screen.getByLabelText("Type to chat"), "never mind");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith("never mind");
  });
});

describe("the command bar", () => {
  it("attaches files to the line that is sent, and a slash command is never given files", async () => {
    stubUpload();
    const onSend = vi.fn();
    render(<CommandBar onSend={onSend} requestOpen={1} hud={{ name: "Maya", style: {} }} />);
    await userEvent.upload(chooser(), file("deck.pptx"));
    await waitFor(() => screen.getByRole("button", { name: "Remove deck.pptx" }));
    await userEvent.type(screen.getByLabelText("Message"), "what is in this?{Enter}");
    expect(onSend).toHaveBeenCalledWith("what is in this?", [{ id: "0123456789abcdef", name: "deck.pptx" }]);
    expect(screen.queryByRole("list", { name: "Attached files" })).toBeNull();
  });

  it("sends the files alone when nothing is typed", async () => {
    stubUpload();
    const onSend = vi.fn();
    render(<CommandBar onSend={onSend} requestOpen={1} hud={{ name: "Maya", style: {} }} />);
    await userEvent.upload(chooser(), file("a.pdf"));
    await waitFor(() => screen.getByRole("button", { name: "Remove a.pdf" }));
    fireEvent.submit(screen.getByLabelText("Message").closest("form")!);
    expect(onSend).toHaveBeenCalledWith(FILES_ONLY_TEXT, [{ id: "0123456789abcdef", name: "a.pdf" }]);
  });
});

describe("the limits in Settings", () => {
  const view = (a: AttachmentSettings) => ({ provider: "claude", model: "m", apiKeySet: false, view: "companion", look: {}, ollama: {}, claudeCode: {}, voice: {}, attachments: a }) as unknown as SettingsView;
  const base: AttachmentSettings = { maxBytes: 10485760, maxFiles: 5, keepDays: 30 };
  it("sends only what changed", () => {
    expect(diffSettings(view(base), view({ ...base }), "")).toEqual({});
    expect(diffSettings(view(base), view({ ...base, maxFiles: 8, keepDays: 7 }), "")).toEqual({ attachments: { maxFiles: 8, keepDays: 7 } });
  });
});
