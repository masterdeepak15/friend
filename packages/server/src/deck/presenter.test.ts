import type { Deck, ServerMsg } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { Presenter } from "./presenter";

const item = (id: string, say = `say ${id}`, extra: object = {}) => ({ id, kind: "text", content: { text: id }, say, ...extra });
const mk = (...slides: { id: string; items: ReturnType<typeof item>[] }[]): Deck => ({ id: "d_1", title: "Hacking", createdAt: 1, slides: slides.map((s) => ({ id: s.id, title: `Title ${s.id}`, layout: "bullets" as const, items: s.items })) });
const two = () => mk({ id: "s1", items: [item("a"), item("b")] }, { id: "s2", items: [item("c")] });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function rig(opts: { silence?: number; voice?: boolean } = {}) {
  const views: string[] = [];
  const spoken: string[] = [];
  let finish: (() => void) | null = null;
  let interrupts = 0;
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const p = new Presenter({
    speak: (t) => {
      spoken.push(t);
      return new Promise<void>((res) => (finish = res));
    },
    interrupt: () => {
      interrupts++;
      finish?.();
    },
    emit: (m: ServerMsg) => {
      if (m.type !== "stage" || m.command.cmd !== "deck") return;
      const v = m.command.view;
      views.push(v ? `${v.state}:${v.index}:${v.shown}` : "off");
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
    resumeSilenceSeconds: () => opts.silence ?? 20,
    voiceOn: () => opts.voice ?? true,
  });
  return {
    p,
    views,
    spoken,
    get interrupts() {
      return interrupts;
    },
    /** The line being spoken ends by itself. */
    async said() {
      finish?.();
      await flush();
    },
    /** The earliest timer that is still wanted goes off. */
    async fire() {
      const t = timers.find((x) => x.live);
      if (!t) throw new Error("no timer is waiting");
      t.live = false;
      t.fn();
      await flush();
    },
    live: () => timers.filter((t) => t.live),
  };
}

describe("presenting a deck", () => {
  it("shows an item and says it, one after the other, slide after slide, to the end", async () => {
    const r = rig();
    r.p.start(two());
    await flush();
    expect(r.views.at(-1)).toBe("playing:0:1");
    expect(r.spoken).toEqual(["say a"]);
    await r.said();
    expect(r.views.at(-1)).toBe("playing:0:2");
    await r.said();
    await r.fire(); // the beat between slides
    expect(r.views).toContain("playing:1:0");
    expect(r.views.at(-1)).toBe("playing:1:1");
    expect(r.spoken).toEqual(["say a", "say b", "say c"]);
    await r.said();
    expect(r.views.at(-1)).toBe("ended:1:1");
    await r.fire();
    expect(r.views.at(-1)).toBe("off");
    expect(r.p.view()).toBeNull();
  });

  it("waits the hold of an item after saying it", async () => {
    const r = rig();
    r.p.start(mk({ id: "s", items: [item("a", "x", { hold: 3 }), item("b")] }));
    await flush();
    await r.said();
    expect(r.views.at(-1)).toBe("playing:0:1");
    expect(r.live()[0]!.ms).toBe(3000);
    await r.fire();
    expect(r.views.at(-1)).toBe("playing:0:2");
  });

  it("refuses to start from a place that is not in the deck, and says so", () => {
    const r = rig();
    expect(r.p.start(two(), { slide: 9, item: 1 })).toMatch(/slide 9/);
    expect(r.p.view()).toBeNull();
  });

  it("starts from a given slide and item", async () => {
    const r = rig();
    r.p.start(two(), { slide: 1, item: 2 });
    await flush();
    expect(r.spoken).toEqual(["say b"]);
    expect(r.views.at(-1)).toBe("playing:0:2");
  });
});

describe("the owner speaks during it", () => {
  it("stops the speech, pauses on that item, and says where it is for the model", async () => {
    const r = rig();
    r.p.start(two());
    await flush();
    await r.said();
    r.p.userSpoke();
    await flush();
    expect(r.interrupts).toBe(1);
    expect(r.views.at(-1)).toBe("paused:0:2");
    expect(r.p.contextLine()).toMatch(/Hacking.*paused at slide 1 of 2, item 2/);
    expect(r.p.contextLine()).toMatch(/deck\.control/);
    expect(r.spoken).toEqual(["say a", "say b"]); // nothing goes on by itself
  });

  it("goes on by repeating the interrupted item, and then continues", async () => {
    const r = rig();
    r.p.start(two());
    await flush();
    await r.said();
    r.p.userSpoke();
    await flush();
    r.p.control("resume");
    await flush();
    expect(r.spoken).toEqual(["say a", "say b", "say b"]);
    expect(r.views.at(-1)).toBe("playing:0:2");
    await r.said();
    await r.fire();
    expect(r.spoken.at(-1)).toBe("say c");
  });

  it("a second interruption while paused changes nothing", async () => {
    const r = rig();
    r.p.start(two());
    await flush();
    r.p.userSpoke();
    r.p.userSpoke();
    await flush();
    expect(r.interrupts).toBe(1);
    expect(r.views.filter((v) => v.startsWith("paused"))).toHaveLength(1);
  });

  it("goes on by itself after the silence, and the wait is the setting", async () => {
    const r = rig({ silence: 7 });
    r.p.start(two());
    await flush();
    r.p.userSpoke();
    await flush();
    expect(r.live()).toHaveLength(0); // while she answers there is no countdown
    r.p.answered();
    expect(r.live().map((t) => t.ms)).toEqual([7000]);
    await r.fire();
    expect(r.views.at(-1)).toBe("playing:0:1");
    expect(r.spoken).toEqual(["say a", "say a"]);
  });

  it("does not go on by itself when the setting is 0, and the owner speaking again cancels the countdown", async () => {
    const never = rig({ silence: 0 });
    never.p.start(two());
    await flush();
    never.p.userSpoke();
    never.p.answered();
    expect(never.live()).toHaveLength(0);

    const r = rig();
    r.p.start(two());
    await flush();
    r.p.userSpoke();
    r.p.answered();
    expect(r.live()).toHaveLength(1);
    r.p.userSpoke();
    expect(r.live()).toHaveLength(0);
    expect(r.views.at(-1)).toBe("paused:0:1");
  });

  it("paused on the last item, going on ends the deck cleanly", async () => {
    const r = rig();
    r.p.start(mk({ id: "s", items: [item("a")] }));
    await flush();
    r.p.userSpoke();
    await flush();
    r.p.control("resume");
    await flush();
    await r.said();
    expect(r.views.at(-1)).toBe("ended:0:1");
    expect(r.spoken).toEqual(["say a", "say a"]);
  });

  it("an approval card pauses it and it goes on when the card is answered, but not if the owner had paused it", async () => {
    const r = rig();
    r.p.start(two());
    await flush();
    r.p.approvalPending(true);
    await flush();
    expect(r.views.at(-1)).toBe("paused:0:1");
    r.p.approvalPending(false);
    await flush();
    expect(r.views.at(-1)).toBe("playing:0:1");

    const o = rig();
    o.p.start(two());
    await flush();
    o.p.control("pause");
    o.p.approvalPending(true);
    o.p.approvalPending(false);
    await flush();
    expect(o.views.at(-1)).toBe("paused:0:1");
  });
});

describe("steering it", () => {
  it("next and back move by slide, goto jumps, repeat plays the slide again, stop puts it away", async () => {
    const r = rig();
    r.p.start(two());
    await flush();
    r.p.control("next");
    await flush();
    expect(r.views.at(-1)).toBe("playing:1:1");
    r.p.control("back");
    await flush();
    expect(r.views.at(-1)).toBe("playing:0:1");
    r.p.control("goto", 2);
    await flush();
    expect(r.views.at(-1)).toBe("playing:1:1");
    r.p.control("repeat");
    await flush();
    expect(r.spoken.at(-1)).toBe("say c");
    expect(r.p.control("goto", 9)).toMatch(/only 2 slides/);
    r.p.control("stop");
    expect(r.views.at(-1)).toBe("off");
    expect(r.p.control("next")).toMatch(/no presentation/i);
  });

  it("starting another one replaces the running one", async () => {
    const r = rig();
    r.p.start(two());
    await flush();
    const other = { ...mk({ id: "z", items: [item("q")] }), id: "d_2", title: "Other" };
    expect(r.p.start(other)).toMatch(/Other/);
    await flush();
    expect(r.spoken.at(-1)).toBe("say q");
  });

  it("when its deck is deleted it stops, and when it is edited it carries on with the new slides", async () => {
    const r = rig();
    r.p.start(two());
    await flush();
    r.p.deckChanged("d_1", mk({ id: "s1", items: [item("a")] }));
    expect(r.p.view()!.total).toBe(1);
    expect(r.p.deckChanged("d_1", null)).toMatch(/deleted/);
    expect(r.views.at(-1)).toBe("off");
    expect(r.p.deckChanged("d_other", null)).toBeNull();
  });

  it("without a voice it shows the items and goes on after the time it takes to read them", async () => {
    const r = rig({ voice: false });
    r.p.start(mk({ id: "s", items: [item("a", "one two three four five six seven eight nine"), item("b")] }));
    await flush();
    expect(r.spoken).toEqual([]);
    expect(r.live()[0]!.ms).toBe(3000); // nine words, three a second
    await r.fire();
    expect(r.views.at(-1)).toBe("playing:0:2");
    expect(r.live()[0]!.ms).toBe(2000); // never less than two seconds
  });
});
