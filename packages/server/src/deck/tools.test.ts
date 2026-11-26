import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db";
import { Presenter } from "./presenter";
import { DeckStore } from "./store";
import { runDeckTool, type DeckToolDeps } from "./tools";

const text = (t: string, say = `say ${t}`) => ({ kind: "text", content: { text: t }, say });
const slide = (title: string, ...items: string[]) => ({ title, layout: "bullets" as const, items: items.map((i) => text(i)) });

function rig(trust: "owner" | "guest" = "owner") {
  const store = new DeckStore(openDb(mkdtempSync(join(tmpdir(), "friend-decktools-"))));
  const spoken: string[] = [];
  const presenter = new Presenter({ speak: async (t) => void spoken.push(t), interrupt: () => {}, emit: () => {}, setTimer: () => () => {}, resumeSilenceSeconds: () => 20, voiceOn: () => true });
  const exportDeck = vi.fn(async (id: string, format: string) => `/files/${id}.${format}`);
  const d: DeckToolDeps = { store, presenter, trust, exportDeck };
  const run = (name: string, args: object) => runDeckTool(name, args, d);
  return { run, store, presenter, exportDeck, spoken };
}
const idOf = (r: { text: string }) => /d_[0-9a-f]{8}/.exec(r.text)![0];

describe("the deck tools", () => {
  it("make a deck, list it and read it back as an outline", async () => {
    const t = rig();
    const made = await t.run("deck.create", { title: "Hacking", slides: [slide("Intro", "What is it"), slide("Recon", "Scan", "Banner")] });
    expect(made.isError).toBe(false);
    const id = idOf(made);
    expect((await t.run("deck.list", {})).text).toMatch(new RegExp(`${id}.*Hacking.*2 slides`));
    const shown = (await t.run("deck.show", { id })).text;
    expect(shown).toMatch(/1\. Intro/);
    expect(shown).toMatch(/2\. Recon/);
    expect(shown).toMatch(/Banner/);
    expect(shown).toMatch(/say Banner/);
  });

  it("say what is wrong with a deck that is too big for its slide", async () => {
    const r = await rig().run("deck.create", { title: "T", slides: [slide("Big", "1", "2", "3", "4", "5", "6")] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/split/);
  });

  it("are for the owner only", async () => {
    for (const name of ["deck.create", "deck.list", "deck.present", "deck.control"]) {
      const r = await rig("guest").run(name, { title: "T", slides: [slide("a", "b")], id: "d_00000000", action: "next" });
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/owner/);
    }
  });

  it("change a deck: add, replace, move and delete slides and items, counting from 1", async () => {
    const t = rig();
    const id = idOf(await t.run("deck.create", { title: "T", slides: [slide("A", "a1", "a2"), slide("B", "b1")] }));
    expect((await t.run("deck.edit", { id, op: "add-slide", slideData: slide("C", "c1") })).isError).toBe(false);
    expect((await t.run("deck.edit", { id, op: "move-slide", slide: 3, to: 1 })).isError).toBe(false);
    expect(t.store.get(id)!.slides.map((s) => s.title)).toEqual(["C", "A", "B"]);
    await t.run("deck.edit", { id, op: "add-item", slide: 2, itemData: text("a3"), at: 1 });
    expect(t.store.get(id)!.slides[1]!.items.map((i) => i.content.text)).toEqual(["a3", "a1", "a2"]);
    await t.run("deck.edit", { id, op: "replace-item", slide: 2, item: 1, itemData: text("new") });
    await t.run("deck.edit", { id, op: "delete-item", slide: 2, item: 2 });
    expect(t.store.get(id)!.slides[1]!.items.map((i) => i.content.text)).toEqual(["new", "a2"]);
    await t.run("deck.edit", { id, op: "replace-slide", slide: 1, slideData: slide("C2", "c") });
    await t.run("deck.edit", { id, op: "delete-slide", slide: 3 });
    expect(t.store.get(id)!.slides.map((s) => s.title)).toEqual(["C2", "A"]);
    const bad = await t.run("deck.edit", { id, op: "delete-slide", slide: 9 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/slide 9/);
  });

  it("refuse an edit that breaks the limits and leave the deck as it was", async () => {
    const t = rig();
    const id = idOf(await t.run("deck.create", { title: "T", slides: [slide("A", "1", "2", "3", "4", "5")] }));
    const r = await t.run("deck.edit", { id, op: "add-item", slide: 1, itemData: text("6") });
    expect(r.isError).toBe(true);
    expect(t.store.get(id)!.slides[0]!.items).toHaveLength(5);
  });

  it("present a deck and steer it, and say when there is nothing to steer", async () => {
    const t = rig();
    expect((await t.run("deck.control", { action: "next" })).text).toMatch(/no presentation/i);
    expect((await t.run("deck.present", { id: "d_00000000" })).isError).toBe(true);
    const id = idOf(await t.run("deck.create", { title: "Hacking", slides: [slide("A", "a1"), slide("B", "b1")] }));
    const r = await t.run("deck.present", { id });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Hacking/);
    await new Promise((x) => setTimeout(x, 5));
    expect(t.spoken[0]).toBe("say a1");
    expect((await t.run("deck.control", { action: "stop" })).text).toMatch(/Stopped/);
  });

  it("stop a presentation when its deck is deleted, and edit it while it plays", async () => {
    const t = rig();
    const id = idOf(await t.run("deck.create", { title: "Hacking", slides: [slide("A", "a1"), slide("B", "b1")] }));
    await t.run("deck.present", { id });
    await t.run("deck.edit", { id, op: "delete-slide", slide: 2 });
    expect(t.presenter.view()!.total).toBe(1);
    const gone = await t.run("deck.delete", { id });
    expect(gone.text).toMatch(/deleted/);
    expect(t.presenter.view()).toBeNull();
    expect(t.store.get(id)).toBeNull();
  });

  it("export through the owner's files area", async () => {
    const t = rig();
    const id = idOf(await t.run("deck.create", { title: "T", slides: [slide("A", "a1")] }));
    const r = await t.run("deck.export", { id, format: "pptx" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`/files/${id}.pptx`);
    expect((await t.run("deck.export", { id: "d_00000000", format: "html" })).isError).toBe(true);
  });
});
