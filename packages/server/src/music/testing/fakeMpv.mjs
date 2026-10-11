// A stand-in for mpv in tests: it listens on the pipe or socket given by --input-ipc-server and speaks the same newline-delimited JSON.
// It writes every command it gets to the file named by FAKE_MPV_LOG. File names decide what happens: EOF ends the track after a moment,
// FAILFILE fails to open it, CRASH makes the program exit, HANG makes it ignore the command.
import { appendFileSync } from "node:fs";
import net from "node:net";

const arg = process.argv.find((a) => a.startsWith("--input-ipc-server="));
if (!arg) process.exit(2);
const path = arg.slice("--input-ipc-server=".length);
const log = process.env.FAKE_MPV_LOG;
const observers = new Map();
let sockets = new Set();
const send = (o) => {
  for (const s of sockets) s.write(JSON.stringify(o) + "\n");
};
const prop = (name, data) => {
  for (const [id, n] of observers) if (n === name) send({ event: "property-change", id, name, data });
};

const server = net.createServer((sock) => {
  sockets.add(sock);
  sock.on("close", () => sockets.delete(sock));
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (log) appendFileSync(log, JSON.stringify({ command: msg.command }) + "\n");
      const [name, a, b] = msg.command;
      if (name === "loadfile" && String(a).includes("CRASH")) process.exit(3);
      if (name === "loadfile" && String(a).includes("HANG")) continue;
      sock.write(JSON.stringify({ error: "success", request_id: msg.request_id, data: null }) + "\n");
      if (name === "observe_property") observers.set(a, b);
      if (name === "set_property") prop(a, b);
      if (name === "loadfile") {
        const f = String(a);
        setTimeout(() => {
          if (f.includes("FAILFILE")) return send({ event: "end-file", reason: "error", file_error: "loading failed" });
          prop("duration", 200);
          prop("time-pos", 1.5);
          if (f.includes("EOF")) setTimeout(() => send({ event: "end-file", reason: "eof" }), 30);
        }, 20);
      }
      if (name === "quit") process.exit(0);
    }
  });
});
server.listen(path);
process.on("SIGTERM", () => process.exit(0));
