import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandBar } from "./CommandBar";
import { buildCommands, buildSlash, type CommandDeps } from "./appCommands";
import { filterCommands, parseSlash, runSlash, unescapeSlash } from "./commands";

afterEach(cleanup);

function deps(over: Partial<CommandDeps> = {}): CommandDeps {
  return {
    notify: vi.fn(),
    openSettings: vi.fn(),
    openPlugins: vi.fn(),
    openVoice: vi.fn(),
    muted: false,
    setMuted: vi.fn(),
    cameraOn: false,
    setCamera: vi.fn(),
    clearScreen: vi.fn(),
    statusLine: () => "Ready",
    endSession: vi.fn(),
    panelOn: () => false,
    setPanel: vi.fn(),
    view: "companion",
    setView: vi.fn(),
    resetLayout: vi.fn(),
    ...over,
  };
}

describe("parsing", () => {
  it("splits a command from its argument", () => {
    expect(parseSlash("/camera on")).toEqual({ name: "camera", args: "on" });
    expect(parseSlash("  /Settings  ")).toEqual({ name: "settings", args: "" });
    expect(parseSlash("/")).toEqual({ name: "", args: "" });
  });
  it("is not a command without exactly one leading slash", () => {
    expect(parseSlash("hello /settings")).toBeNull();
    expect(parseSlash("//server/share")).toBeNull();
    expect(unescapeSlash("//server/share")).toBe("/server/share");
    expect(unescapeSlash("plain")).toBe("plain");
  });
  it("lists commands that start with what was typed first, then ones that contain it", () => {
    const names = (t: string) => filterCommands(buildCommands(deps()), t).map((c) => c.name);
    expect(names("/")).toContain("settings");
    expect(names("/se")[0]).toBe("settings");
    expect(names("/ug")).toEqual(["plugins"]);
    expect(names("/camera on")).toEqual(["camera"]);
    expect(names("/zzz")).toEqual([]);
    expect(names("hello")).toEqual([]);
  });
});

describe("the commands", () => {
  it("open the screens", () => {
    const d = deps();
    const cmds = buildCommands(d);
    runSlash(cmds, "/settings", d.notify);
    runSlash(cmds, "/plugins", d.notify);
    runSlash(cmds, "/voice", d.notify);
    expect([d.openSettings, d.openPlugins, d.openVoice].map((f) => (f as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1, 1]);
  });
  it("say how to set up speech when it is not available", () => {
    const d = deps({ openVoice: null });
    runSlash(buildCommands(d), "/voice", d.notify);
    expect(d.notify).toHaveBeenCalledWith(expect.stringMatching(/friend voice setup/));
  });
  it("switch the camera on, off, or the other way round", () => {
    const d = deps({ cameraOn: true });
    const cmds = buildCommands(d);
    runSlash(cmds, "/camera on", d.notify);
    runSlash(cmds, "/camera off", d.notify);
    runSlash(cmds, "/camera", d.notify);
    expect((d.setCamera as ReturnType<typeof vi.fn>).mock.calls).toEqual([[true], [false], [false]]);
    runSlash(cmds, "/camera maybe", d.notify);
    expect(d.setCamera).toHaveBeenCalledTimes(3);
  });
  it("mute, unmute, clear, status, logout and lock", () => {
    const d = deps();
    const cmds = buildCommands(d);
    for (const c of ["/mute", "/unmute", "/clear", "/status", "/logout", "/lock"]) runSlash(cmds, c, d.notify);
    expect((d.setMuted as ReturnType<typeof vi.fn>).mock.calls).toEqual([[true], [false]]);
    expect(d.clearScreen).toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith("Ready");
    expect((d.endSession as ReturnType<typeof vi.fn>).mock.calls).toEqual([["logout"], ["lock"]]);
  });
  it("/help lists them all, and an unknown command says so", () => {
    const d = deps();
    const cmds = buildCommands(d);
    runSlash(cmds, "/help", d.notify);
    const help = (d.notify as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    for (const c of cmds) expect(help).toContain(`/${c.name}`);
    runSlash(cmds, "/nope", d.notify);
    expect(d.notify).toHaveBeenLastCalledWith(expect.stringMatching(/no command \/nope/i));
  });
});

describe("panel, view and layout commands", () => {
  it("/chat and /tasks switch the panels on, off, or the other way round", () => {
    const d = deps({ panelOn: (id) => id === "tasks" });
    const cmds = buildCommands(d);
    runSlash(cmds, "/chat", d.notify);
    runSlash(cmds, "/chat off", d.notify);
    runSlash(cmds, "/tasks", d.notify);
    runSlash(cmds, "/tasks on", d.notify);
    expect((d.setPanel as ReturnType<typeof vi.fn>).mock.calls).toEqual([["chat", true], ["chat", false], ["tasks", false], ["tasks", true]]);
    runSlash(cmds, "/chat maybe", d.notify);
    expect(d.setPanel).toHaveBeenCalledTimes(4);
    expect(d.notify).toHaveBeenCalledWith(expect.stringMatching(/\/chat on or off/));
  });

  it("/view sets the view, or says which one is on", () => {
    const d = deps({ view: "minimal" });
    const cmds = buildCommands(d);
    runSlash(cmds, "/view workspace", d.notify);
    expect(d.setView).toHaveBeenCalledWith("workspace");
    runSlash(cmds, "/view", d.notify);
    expect(d.notify).toHaveBeenLastCalledWith(expect.stringMatching(/view is minimal/));
    runSlash(cmds, "/view huge", d.notify);
    expect(d.setView).toHaveBeenCalledTimes(1);
  });

  it("/layout reset puts the panels back, anything else explains", () => {
    const d = deps();
    const cmds = buildCommands(d);
    runSlash(cmds, "/layout reset", d.notify);
    expect(d.resetLayout).toHaveBeenCalled();
    runSlash(cmds, "/layout", d.notify);
    expect(d.notify).toHaveBeenLastCalledWith(expect.stringMatching(/Drag a panel/));
  });

  it("/help names them all", () => {
    const d = deps();
    runSlash(buildCommands(d), "/help", d.notify);
    const help = (d.notify as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    for (const n of ["/chat", "/tasks", "/view", "/layout"]) expect(help).toContain(n);
  });
});

describe("the message bar", () => {
  const bar = (d = deps()) => {
    const onSend = vi.fn();
    render(<CommandBar onSend={onSend} requestOpen={1} slash={buildSlash(d)} />);
    return { onSend, d };
  };

  it("shows the commands as soon as a slash is typed, and narrows them", async () => {
    bar();
    await userEvent.type(screen.getByLabelText("Message"), "/");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(5);
    await userEvent.type(screen.getByLabelText("Message"), "set");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("/settings")]);
  });

  it("runs the highlighted match on Enter and never sends it to the AI", async () => {
    const { onSend, d } = bar();
    await userEvent.type(screen.getByLabelText("Message"), "/set{Enter}");
    expect(d.openSettings).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Message")).toBeNull();
  });

  it("moves the highlight with the arrows and completes with Tab", async () => {
    const { d } = bar();
    const box = screen.getByLabelText("Message") as HTMLInputElement;
    await userEvent.type(box, "/p");
    expect(screen.getAllByRole("option")[0]!.textContent).toContain("/plugins");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{ArrowUp}{Tab}");
    expect(box.value).toBe("/plugins ");
    await userEvent.keyboard("{Enter}");
    expect(d.openPlugins).toHaveBeenCalled();
  });

  it("passes an argument to the command", async () => {
    const { d } = bar();
    await userEvent.type(screen.getByLabelText("Message"), "/camera on{Enter}");
    expect(d.setCamera).toHaveBeenCalledWith(true);
  });

  it("clicking a choice fills it in", async () => {
    bar();
    const box = screen.getByLabelText("Message") as HTMLInputElement;
    await userEvent.type(box, "/cam");
    await userEvent.click(screen.getByRole("option", { name: /camera/ }));
    expect(box.value).toBe("/camera ");
  });

  it("tells the owner about an unknown command instead of asking the AI", async () => {
    const { onSend, d } = bar();
    await userEvent.type(screen.getByLabelText("Message"), "/zzz{Enter}");
    expect(d.notify).toHaveBeenCalledWith(expect.stringMatching(/\/zzz/));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends ordinary text, and a doubled slash as a single one", async () => {
    const { onSend } = bar();
    await userEvent.type(screen.getByLabelText("Message"), "hello there{Enter}");
    expect(onSend).toHaveBeenLastCalledWith("hello there");
  });

  it("sends a path that starts with two slashes", async () => {
    const onSend = vi.fn();
    render(<CommandBar onSend={onSend} requestOpen={1} slash={buildSlash(deps())} />);
    await userEvent.type(screen.getByLabelText("Message"), "//server/share{Enter}");
    expect(onSend).toHaveBeenCalledWith("/server/share");
  });

  it("closes on Escape", async () => {
    bar();
    await userEvent.type(screen.getByLabelText("Message"), "/{Escape}");
    expect(screen.queryByLabelText("Message")).toBeNull();
  });

  it("sends a slash line like any message when there are no commands wired up", async () => {
    const onSend = vi.fn();
    render(<CommandBar onSend={onSend} requestOpen={1} />);
    await userEvent.type(screen.getByLabelText("Message"), "/hello{Enter}");
    expect(onSend).toHaveBeenCalledWith("/hello");
  });
});
