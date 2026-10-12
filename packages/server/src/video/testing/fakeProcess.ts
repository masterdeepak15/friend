import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/** A stand-in for a child program (ffmpeg or mpv), for tests: it records how it was started, hands out bytes, and can be told to end. */
export interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  killed: boolean;
  kill(): boolean;
  pid: number;
  /** Ends the program as if it finished by itself. */
  finish(code?: number): void;
}

export interface FakeSpawn {
  spawn: (cmd: string, args: readonly string[], opts?: unknown) => FakeChild;
  calls: { cmd: string; args: string[] }[];
  children: FakeChild[];
  /** What each new program writes to its output as soon as it starts (default: a few bytes). */
  output: Buffer | null;
  /** Make the next start fail as if the program were not there. */
  failToStart: boolean;
}

export function fakeSpawn(): FakeSpawn {
  const f: FakeSpawn = {
    calls: [],
    children: [],
    output: Buffer.from("FMP4DATA"),
    failToStart: false,
    spawn: (cmd, args) => {
      if (f.failToStart) {
        throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
      }
      f.calls.push({ cmd, args: [...args] });
      const c = new EventEmitter() as FakeChild;
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.stdin = new PassThrough();
      c.killed = false;
      c.pid = 1000 + f.children.length;
      c.kill = () => {
        if (c.killed) return false;
        c.killed = true;
        setImmediate(() => {
          c.stdout.end();
          c.emit("exit", null, "SIGTERM");
          c.emit("close", null);
        });
        return true;
      };
      c.finish = (code = 0) => {
        c.stdout.end();
        c.emit("exit", code, null);
        c.emit("close", code);
      };
      f.children.push(c);
      if (f.output) setImmediate(() => c.stdout.write(f.output!));
      return c;
    },
  };
  return f;
}
