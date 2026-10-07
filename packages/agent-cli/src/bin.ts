#!/usr/bin/env node
import { defaultDataDir } from "@friend/server";
import { createInterface } from "node:readline";
import { run, type IO } from "./cli";

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // piped input: read a line without echo handling
      const rl = createInterface({ input: stdin });
      rl.once("line", (l) => {
        rl.close();
        resolve(l);
      });
      return;
    }
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(buf);
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

function askVisible(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    });
  });
}

const io: IO = {
  dataDir: defaultDataDir(),
  out: (s) => console.log(s),
  err: (s) => console.error(s),
  ask: (q, opts) => (opts?.hidden ? askHidden(q) : askVisible(q)),
};

run(process.argv.slice(2), io).then((code) => {
  if (code !== 0) process.exitCode = code;
});
