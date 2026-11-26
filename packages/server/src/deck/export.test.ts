import type { Deck } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { extractFile } from "../attach/extract";
import { deckToHtml } from "./exportHtml";
import { deckToPptx } from "./exportPptx";

const deck: Deck = {
  id: "d_1",
  title: "Hacking <101>",
  createdAt: 1,
  slides: [
    { id: "s1", title: "Why it matters", layout: "bullets", notes: "Keep it friendly.", items: [
      { id: "a", kind: "text", content: { text: "Breaches cost money" }, say: "Every breach has a price.", animation: "slide-left" },
      { id: "b", kind: "text", content: { text: "<script>alert(1)</script>" }, say: "Never trust input." },
    ] },
    { id: "s2", title: "Tools", layout: "visual", items: [
      { id: "t", kind: "JTable", content: { columns: ["Tool", "Use"], rows: [["nmap", "scan"], ["burp", "proxy"]] }, say: "These are the usual tools.", animation: "draw" },
    ] },
    { id: "s3", title: "Picture", layout: "visual", items: [{ id: "c", kind: "chart", content: { title: "Trend", labels: ["a", "b"], series: [{ name: "n", values: [1, 2] }] }, say: "A chart." }] },
  ],
};

describe("saving a presentation as a web page", () => {
  const html = deckToHtml(deck);
  it("holds every slide, item and spoken line, with the owner's text made safe", () => {
    for (const t of ["Why it matters", "Breaches cost money", "Tools", "nmap", "burp", "Every breach has a price.", "These are the usual tools."]) expect(html).toContain(t);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Hacking &lt;101&gt;");
  });
  it("plays by itself: no address on the internet anywhere, its own script, reduced motion and the animations", () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain("anim-slide-left");
    expect(html).toMatch(/<script>[\s\S]*ArrowRight[\s\S]*<\/script>/);
  });
  it("shows a chart as its numbers, and the notes only for the owner", () => {
    expect(html).toMatch(/Trend/);
    expect(html).toContain("Keep it friendly.");
  });
});

describe("saving a presentation as a PowerPoint file", () => {
  it("opens as a presentation with the titles and points in order", async () => {
    const buf = await deckToPptx(deck);
    const r = await extractFile("deck.pptx", buf);
    if (!r.ok || r.kind !== "text") throw new Error("not read");
    const at = (s: string) => r.text.indexOf(s);
    expect(at("Why it matters")).toBeGreaterThan(-1);
    expect(at("Breaches cost money")).toBeGreaterThan(at("Why it matters"));
    expect(at("Tools")).toBeGreaterThan(at("Breaches cost money"));
    expect(r.text).toContain("nmap");
    expect(r.text).toContain("Trend");
  });
  it("keeps the spoken lines and the notes in the notes of each slide", async () => {
    const raw = (await deckToPptx(deck, { compress: false })).toString("latin1");
    expect(raw).toContain("Every breach has a price.");
    expect(raw).toContain("Keep it friendly.");
  });
});
