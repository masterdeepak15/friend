import { loadConfig } from "@friend/server";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { run, type IO } from "./cli";
import { voiceMenu, voicePaths, voiceSetupCommand, type Runner } from "./commands/voice";

let dataDir: string;
let lines: string[];
const text = () => lines.join("\n");
const ioWith = (answers: string[] = []): IO & { asked: string[] } => {
  const asked: string[] = [];
  return { dataDir, out: (s) => lines.push(s), err: (s) => lines.push(s), ask: async (q) => (asked.push(q), answers.shift() ?? ""), asked };
};
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "friend-voicechoice-"));
  lines = [];
});

function fakeRunner(): { run: Runner; downloaded: () => string } {
  const calls: string[] = [];
  const runner: Runner = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    if (args.includes("--version")) return { code: 0, stdout: "Python 3.12.4" };
    if (args.includes("venv")) {
      const p = voicePaths(dataDir);
      mkdirSync(join(p.venv, process.platform === "win32" ? "Scripts" : "bin"), { recursive: true });
      writeFileSync(p.python, "");
    }
    return { code: 0, stdout: "" };
  };
  return { run: runner, downloaded: () => calls.find((c) => c.includes("load_engines")) ?? "" };
}
const setup = (answers: string[], args: string[] = []) => {
  const f = fakeRunner();
  const io = ioWith(answers);
  return voiceSetupCommand(io, { run: f.run, voiceDir: "/v" }, args).then((code) => ({ code, io, ...f }));
};

describe("the voice menu", () => {
  it("lists female and male voices separately, numbered like the answer expects, and marks the current one", () => {
    const m = voiceMenu("en_US-amy-medium");
    expect(m[0]).toBe("Female voices");
    expect(m.indexOf("Male voices")).toBeGreaterThan(3);
    expect(m.find((l) => /Amy/.test(l))).toMatch(/^\s+1\s+Amy\s+American\s+<- now$/);
    expect(m.find((l) => /Ryan/.test(l))).toMatch(/^\s+7\s+Ryan/);
    expect(m.at(-1)).toMatch(/original voice \(Lessac.*type lessac/);
    expect(voiceMenu("en_US-lessac-medium").at(-1)).toContain("<- now");
  });
});

describe("friend voice setup: choosing the voice", () => {
  it("asks which voice, showing the list, and keeps the current voice when Enter is pressed", async () => {
    const { code, io } = await setup([""]);
    expect(code).toBe(0);
    expect(text()).toMatch(/Choose the assistant's voice/);
    expect(text()).toMatch(/Female voices[\s\S]*Male voices/);
    expect(io.asked[0]).toMatch(/Enter keeps Lessac/);
    expect(loadConfig(dataDir).voice.ttsVoice).toBe("en_US-lessac-medium");
  });

  it("accepts \"female\" and downloads that voice", async () => {
    const { code, downloaded } = await setup(["female"]);
    expect(code).toBe(0);
    expect(loadConfig(dataDir).voice.ttsVoice).toBe("en_US-amy-medium");
    expect(downloaded()).toContain("en_US-amy-medium");
    expect(JSON.parse(readFileSync(voicePaths(dataDir).marker, "utf8")).ttsVoice).toBe("en_US-amy-medium");
    expect(text()).toMatch(/Voice: Amy \(female, American\)/);
  });

  it("accepts \"male\", a number and a name", async () => {
    expect((await setup(["male"])).downloaded()).toContain("en_US-ryan-medium");
    expect((await setup(["4"])).downloaded()).toContain("en_GB-jenny_dioco-medium");
    expect((await setup(["alba"])).downloaded()).toContain("en_GB-alba-medium");
  });

  it("asks again after something that is not a voice, and gives up kindly after three tries", async () => {
    const again = await setup(["robot", "2"]);
    expect(again.downloaded()).toContain("en_US-kristin-medium");
    expect(text()).toMatch(/"robot" is not on the list/);
    const giveUp = await setup(["x", "y", "z"]);
    expect(giveUp.code).toBe(0);
    expect(loadConfig(dataDir).voice.ttsVoice).not.toMatch(/robot|^x|^y|^z/);
  });

  it("does not ask when a flag says which voice, and refuses a voice that does not exist", async () => {
    const female = await setup([], ["--female"]);
    expect(female.io.asked).toEqual([]);
    expect(female.downloaded()).toContain("en_US-amy-medium");
    expect((await setup([], ["--male"])).downloaded()).toContain("en_US-ryan-medium");
    expect((await setup([], ["--voice", "jenny"])).downloaded()).toContain("jenny_dioco");
    expect((await setup([], ["--voice", "hi_IN-pratham-medium"])).downloaded()).toContain("hi_IN-pratham-medium");
    lines = [];
    const bad = await setup([], ["--voice", "robot"]);
    expect(bad.code).toBe(1);
    expect(text()).toMatch(/"robot" is not a voice.*friend voice list/);
    expect(bad.downloaded()).toBe("");
  });

  it("is chosen through the real command line too", async () => {
    const io = ioWith();
    expect(await run(["voice", "list"], io)).toBe(0);
    expect(text()).toMatch(/Female voices[\s\S]*friend voice setup --voice/);
    lines = [];
    expect(await run(["voice", "nonsense"], io)).toBe(1);
    expect(text()).toMatch(/--female\|--male/);
  });
});

describe("friend setup: the voice question", () => {
  const owner = ["correct horse battery", "123456", "Jarvis", "", "", ""];
  it("is asked last, and the answer is saved", async () => {
    const io = ioWith([...owner.slice(0, 5), "female"]);
    expect(await run(["setup"], io)).toBe(0);
    expect(io.asked.at(-1)).toMatch(/Assistant voice, female or male/);
    expect(loadConfig(dataDir).voice.ttsVoice).toBe("en_US-amy-medium");
  });
  it("keeps the default when left blank", async () => {
    const io = ioWith([...owner]);
    expect(await run(["setup"], io)).toBe(0);
    expect(loadConfig(dataDir).voice.ttsVoice).toBe("en_US-lessac-medium");
  });
  it("keeps the default, and says so, for an answer that is not a voice", async () => {
    const io = ioWith([...owner.slice(0, 5), "robot"]);
    expect(await run(["setup"], io), text()).toBe(0);
    expect(text()).toMatch(/"robot" is not a voice I know/);
    expect(loadConfig(dataDir).voice.ttsVoice).toBe("en_US-lessac-medium");
  });
});
