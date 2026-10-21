// A stand-in for `claude -p` in stream-json mode, for tests. It reads one user line, replays a recorded session to stdout, and exits.
//   FAKE_SESSION   the file to replay (default: ../testdata/session.jsonl)
//   FAKE_HANG=1    never answers and never exits (to test stopping a worker)
//   FAKE_ARGS_OUT  a file to write the arguments it was started with
const fs = require("node:fs");
const path = require("node:path");

if (process.env.FAKE_ARGS_OUT) fs.writeFileSync(process.env.FAKE_ARGS_OUT, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);

const session = process.env.FAKE_SESSION || path.join(__dirname, "..", "testdata", "session.jsonl");
let started = false;
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  if (!started && buf.includes("\n") && !process.env.FAKE_HANG) {
    started = true;
    replay();
  }
});
process.stdin.on("end", () => {
  if (!process.env.FAKE_HANG) process.exit(0);
});

function replay() {
  const lines = fs.readFileSync(session, "utf8").split("\n").filter(Boolean);
  let i = 0;
  const next = () => {
    if (i < lines.length) {
      process.stdout.write(lines[i++] + "\n");
      setImmediate(next);
    } else {
      process.exit(0);
    }
  };
  next();
}