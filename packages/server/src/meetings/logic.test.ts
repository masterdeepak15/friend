import { describe, expect, it } from "vitest";
import { CaptionTracker, Cooldown, concernsOwner, findTeamsLink, isAddressed, isTeamsMeetingUrl, mentions } from "./logic";

describe("captions become finished lines", () => {
  it("waits until a caption stops growing, then says it once", () => {
    const t = new CaptionTracker(2000);
    expect(t.feed([{ speaker: "Ann", text: "we should" }], 0)).toEqual([]);
    expect(t.feed([{ speaker: "Ann", text: "we should ship on Friday" }], 1000)).toEqual([]);
    expect(t.feed([{ speaker: "Ann", text: "we should ship on Friday" }], 2500)).toEqual([]); // changed at 1000: not yet 2000 ago
    expect(t.feed([{ speaker: "Ann", text: "we should ship on Friday" }], 3200)).toEqual([{ speaker: "Ann", text: "we should ship on Friday" }]);
    expect(t.feed([{ speaker: "Ann", text: "we should ship on Friday" }], 9000)).toEqual([]); // not again
  });

  it("finishes an older caption as soon as a newer one appears", () => {
    const t = new CaptionTracker(2000);
    t.feed([{ speaker: "Ann", text: "hello all" }], 0);
    const out = t.feed([{ speaker: "Ann", text: "hello all" }, { speaker: "Bob", text: "hi" }], 300);
    expect(out).toEqual([{ speaker: "Ann", text: "hello all" }]);
  });

  it("gives only the new words when a speaker carries on in the same bubble", () => {
    const t = new CaptionTracker(1000);
    t.feed([{ speaker: "Ann", text: "first part." }], 0);
    expect(t.feed([{ speaker: "Ann", text: "first part." }], 1500)).toEqual([{ speaker: "Ann", text: "first part." }]);
    t.feed([{ speaker: "Ann", text: "first part. second part." }], 2000);
    expect(t.feed([{ speaker: "Ann", text: "first part. second part." }], 3500)).toEqual([{ speaker: "Ann", text: "second part." }]);
  });

  it("flushes what was still being said when the meeting ends", () => {
    const t = new CaptionTracker(5000);
    t.feed([{ speaker: "Ann", text: "last words" }], 0);
    expect(t.flush()).toEqual([{ speaker: "Ann", text: "last words" }]);
    expect(t.flush()).toEqual([]);
  });
});

describe("who is being talked to", () => {
  it("hears its name as a word, in any case, and not inside another word", () => {
    expect(mentions("hey Maya, can you check", ["Maya"])).toBe(true);
    expect(mentions("MAYA?", ["maya"])).toBe(true);
    expect(mentions("the mayan calendar", ["Maya"])).toBe(false);
    expect(mentions("anything", [])).toBe(false);
  });
  it("is not called by its own captions", () => {
    expect(isAddressed({ speaker: "Maya (assistant)", text: "I am Maya" }, ["Maya"], "Maya (assistant)")).toBe(false);
    expect(isAddressed({ speaker: "Ann", text: "Maya, what is the status?" }, ["Maya"], "Maya (assistant)")).toBe(true);
  });
  it("tells the owner about their name or topics, but never about the owner's own words", () => {
    expect(concernsOwner({ speaker: "Ann", text: "Deepak owns the release" }, ["Deepak"], [])).toBe(true);
    expect(concernsOwner({ speaker: "Ann", text: "the invoice is late" }, ["Deepak"], ["invoice"])).toBe(true);
    expect(concernsOwner({ speaker: "Deepak C", text: "I will do the invoice" }, ["Deepak"], ["invoice"])).toBe(false);
    expect(concernsOwner({ speaker: "Ann", text: "lunch?" }, ["Deepak"], ["invoice"])).toBe(false);
  });
  it("spaces out what it does", () => {
    const c = new Cooldown(1000);
    expect(c.take("a", 0)).toBe(true);
    expect(c.take("a", 500)).toBe(false);
    expect(c.take("b", 500)).toBe(true);
    expect(c.take("a", 1500)).toBe(true);
  });
});

describe("Teams links", () => {
  const good = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d";
  it("finds the link in an invitation and drops the punctuation after it", () => {
    expect(findTeamsLink(`Join: ${good}.\nThanks`)).toBe(good);
    expect(findTeamsLink("https://teams.live.com/meet/9876543210?p=abc")).toBe("https://teams.live.com/meet/9876543210?p=abc");
    expect(findTeamsLink("no link here")).toBeNull();
  });
  it("opens nothing but a Teams meeting page", () => {
    expect(isTeamsMeetingUrl(good)).toBe(true);
    for (const bad of ["http://teams.microsoft.com/l/meetup-join/x", "https://evil.com/l/meetup-join/x", "https://teams.microsoft.com.evil.com/l/meetup-join/x", "https://user:pw@teams.microsoft.com/l/meetup-join/x", "https://teams.microsoft.com:8443/l/meetup-join/x", "https://teams.microsoft.com/_#/settings", "http://127.0.0.1/meet/1", "javascript:alert(1)", "not a url"]) expect(isTeamsMeetingUrl(bad)).toBe(false);
  });
});
