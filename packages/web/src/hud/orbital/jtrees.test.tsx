import { jarvisObjectProblem, type JarvisNode } from "@friend/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HudStats } from "../../store";
import { JLive, useRolling } from "./JLive";
import { feedTree, networkTree, radarTree, systemTree, ticketsTree, voiceTree } from "./jtrees";

const stats: HudStats = { cpu: 42.4, ramUsed: 6 * 2 ** 30, ramTotal: 16 * 2 ** 30, netDown: 2048, netUp: 512, at: Date.now() };
const ok = (n: JarvisNode) => jarvisObjectProblem(n.c, { ...(n.p ?? {}), ...(n.kids ? { kids: n.kids } : {}) });
const text = (n: JarvisNode | string): string => (typeof n === "string" ? n : [JSON.stringify(n.p ?? {}), ...(n.kids ?? []).map(text)].join(" "));

describe("the live instruments as Jarvis trees", () => {
  it("every one is acceptable to the checker that guards what is drawn, with and without data", () => {
    const all: JarvisNode[] = [
      systemTree(stats),
      systemTree(stats, true),
      systemTree(null),
      voiceTree(0.6, "listening"),
      voiceTree(0, "idle"),
      networkTree(stats, [1, 5, 3, 8]),
      networkTree(null, []),
      networkTree({ ...stats, netDown: 0, netUp: 0 }, []),
      feedTree([{ text: "Ada wrote a.txt", tone: "green" }, { text: "Asked: npm install", tone: "orange" }], "Thinking", true),
      feedTree([], null, false),
      radarTree(true, false),
      ticketsTree([{ status: "done" }, { status: "doing" }, { status: "todo" }], "site"),
      ticketsTree([]),
    ];
    for (const n of all) expect(ok(n), n.c + " " + text(n).slice(0, 60)).toBeNull();
  });

  it("show the readings as numbers the owner can read", () => {
    expect(text(systemTree(stats))).toMatch(/"level":42/);
    expect(text(systemTree(stats))).toMatch(/"value":"38%"/); // 6 of 16 GB
    expect(text(systemTree(stats, true))).toMatch(/RAM USED/);
    expect(text(networkTree(stats, []))).toMatch(/"value":"2\.0 KB\/s"/);
    expect(text(networkTree({ ...stats, netDown: 0, netUp: 0 }, []))).toMatch(/n\/a/);
    expect(text(radarTree(false, true))).toMatch(/PC agent offline/);
    expect(text(ticketsTree([{ status: "done" }, { status: "done" }, { status: "todo" }]))).toMatch(/"label":"DONE","value":"2"/);
  });

  it("keep the feed to the newest six lines and put what is happening now last", () => {
    const lines = Array.from({ length: 9 }, (_, i) => ({ text: `line ${i}`, tone: "plain" as const }));
    const t = feedTree(lines, "Thinking", true);
    const first = t.kids![0] as JarvisNode;
    const items = (first.p!.items as { message: string }[]).map((i) => i.message);
    expect(items).toEqual(["line 3", "line 4", "line 5", "line 6", "line 7", "line 8", "Thinking"]);
  });
});

describe("drawing one", () => {
  it("shows the plain drawing while the library is on its way, then the Jarvis one", async () => {
    render(
      <JLive node={systemTree(stats)}>
        <p>plain system</p>
      </JLive>,
    );
    expect(screen.getByText("plain system")).toBeTruthy();
    expect((await screen.findAllByText(/^CPU$/i, {}, { timeout: 5000 })).length).toBeGreaterThan(0);
    expect(screen.queryByText("plain system")).toBeNull();
  });

  it("falls back to the plain drawing for a tree the checker refuses", () => {
    const bad: JarvisNode = { c: "JHudFrameCard", p: { onClick: "alert(1)", title: "x" } };
    render(
      <JLive node={bad}>
        <p>plain</p>
      </JLive>,
    );
    expect(screen.getByText("plain")).toBeTruthy();
  });
});

describe("the rolling history", () => {
  it("adds a reading when the stamp changes, keeps the newest few, and cannot loop on a stamp that changes every draw", async () => {
    function Probe({ v, stamp }: { v: number; stamp: unknown }) {
      const h = useRolling(v, stamp, 3);
      return <p data-testid="h">{h.join(",")}</p>;
    }
    const { rerender } = render(<Probe v={1} stamp={1} />);
    expect((await screen.findByTestId("h")).textContent).toBe("1");
    rerender(<Probe v={2} stamp={2} />); // inside the same second: not added
    expect(screen.getByTestId("h").textContent).toBe("1");
    function Always() {
      const h = useRolling(5, Math.random(), 3); // a new stamp on every draw
      return <p data-testid="a">{h.length}</p>;
    }
    render(<Always />);
    expect((await screen.findAllByTestId("a"))[0]!.textContent).toBe("1");
  });
});
