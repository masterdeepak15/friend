import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { FakeProvider } from "../provider/fake";
import { AudioHearing } from "./hearing";
import type { CaptionItem } from "./logic";
import type { MeetingService } from "./service";
import type { MeetingPage, Phase } from "./session";
import type { MeetingStore } from "./store";

let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const until = async (cond: () => boolean, ms = 20_000) => {
  for (let t = 0; t < ms && !cond(); t += 25) await new Promise((r) => setTimeout(r, 25));
  if (!cond()) throw new Error("timed out waiting");
};

const tone = (s: number) => {
  const b = Buffer.alloc(Math.floor(s * 16000) * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(Math.sin(i / 9) * 9000), i * 2);
  return Buffer.concat([b, Buffer.alloc(16000 * 2)]);
};

/** A call with no captions, whose sound comes in as the sentences the test says. */
class Call implements MeetingPage {
  sound: Buffer[] = [tone(0.2)]; // what is there on arrival is thrown away
  left = false;
  async open() {}
  async advance() {
    return { phase: (this.left ? "ended" : "in") as Phase, detail: "" };
  }
  async captions(): Promise<CaptionItem[] | null> {
    return null;
  }
  async enableCaptions() {}
  async chat() {
    return true;
  }
  async leave() {
    this.left = true;
  }
  async close() {}
  async mic() {
    return true;
  }
  async camera() {
    return true;
  }
  async speak() {
    return true;
  }
  async audio() {
    return this.sound.shift() ?? Buffer.alloc(0);
  }
}

async function boot(script: ConstructorParameters<typeof FakeProvider>[0], sentences: { text: string; speaker?: string; verified?: boolean }[]) {
  const page = new Call();
  let n = 0;
  for (let i = 0; i < Math.min(sentences.length, 1); i++) page.sound.push(tone(1.5)); // the others are said by the test, later
  const dir = mkdtempSync(join(tmpdir(), "friend-ownerturn-"));
  const model = new FakeProvider(script);
  const h: { service?: MeetingService; store?: MeetingStore } = {};
  app = await createApp({
    dataDir: dir,
    provider: model,
    config: { port: 0, roots: [], meetings: { installed: true, enabled: true } },
    pluginCatalogDir: join(dir, "none"),
    meetingPage: () => page,
    meetingVoice: { speech: async () => Buffer.from("RIFF"), hearing: () => new AudioHearing({ transcribe: async () => sentences[n++] ?? "" }) },
    meetingTuning: { pollMs: 5, settleMs: 40, replyDelayMs: 20, retryMs: 500 },
    meetingHandles: (x) => Object.assign(h, x),
  });
  const { port } = await app.start();
  await fetch(`http://127.0.0.1:${port}/api/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse battery", pin: "123456", assistantName: "Maya" }) });
  return { model, service: h.service!, store: h.store!, page };
}

describe("a turn started by the owner's voice in a meeting", () => {
  it("has all the usual tools and can leave the call, while anyone else's turn keeps only the meeting tools", async () => {
    const t = await boot(
      [
        [{ type: "tool_call", id: "1", name: "meeting.leave", args: {} }],
        [{ type: "done" }],
        [{ type: "done" }], // the final notes
        [{ type: "done" }],
      ],
      [{ text: "Maya, please leave the call now.", speaker: "Deepak", verified: true }],
    );
    await t.service.join("https://teams.live.com/meet/501", { title: "Interview" });
    await until(() => t.store.current()?.status === "ended");
    const first = t.model.calls[0]!;
    const names = first.tools.map((x) => x.name);
    expect(names).toContain("meeting.leave");
    expect(names.length).toBeGreaterThan(20); // the owner's whole set, not four or five
    expect(names).toContain("memory.search");
  }, 40_000);

  it("is the owner's voice only: the same words from a voice that was not recognised do nothing", async () => {
    const t = await boot(
      [
        [{ type: "tool_call", id: "1", name: "meeting.leave", args: {} }],
        [{ type: "done" }],
      ],
      [{ text: "Maya, please leave the call now." }], // "Someone": no voiceprint matched
    );
    await t.service.join("https://teams.live.com/meet/502", {});
    await until(() => t.model.calls.length >= 2);
    expect(JSON.stringify(t.model.calls[1]!.messages)).toContain("not possible while handling a meeting");
    expect(t.model.calls[0]!.tools.map((x) => x.name).sort()).toEqual(["meeting.chat", "meeting.look", "meeting.notes", "meeting.people", "meeting.present", "meeting.read_chat", "meeting.save_notes", "meeting.speak", "meeting.tell_owner", "task.add", "weather.get", "web.read", "web.search"]);
    expect(t.store.current()!.status).toBe("live");
  }, 40_000);

  it("sends only what was said since the last turn, with a short note, not the same context and instructions again", async () => {
    const t = await boot(
      [
        [{ type: "tool_call", id: "1", name: "meeting.speak", args: { text: "One." } }],
        [{ type: "done" }],
        [{ type: "tool_call", id: "2", name: "meeting.speak", args: { text: "Two." } }],
        [{ type: "done" }],
      ],
      [{ text: "Maya, tell me the first thing about the plan." }, { text: "Maya, and now tell me the second thing please." }],
    );
    await t.service.join("https://teams.live.com/meet/503", { title: "Plan" });
    await until(() => t.model.calls.length >= 2, 30_000); // it answered the first
    await new Promise((r) => setTimeout(r, 3500)); // and does not listen to itself for a moment
    t.page.sound.push(tone(1.5)); // then the second is said
    await until(() => t.model.calls.length >= 4, 30_000);
    const second = JSON.stringify([...t.model.calls[2]!.messages].reverse().find((m) => m.role === "user"));
    expect(second).toContain("second thing");
    expect(second).not.toContain("first thing"); // it was sent before, and is in what it remembers
    expect(second).toContain("meeting.notes"); // and where to read it again
    expect(second.length).toBeLessThan(1600);
  }, 60_000);
});
