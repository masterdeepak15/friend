import { loadConfig, saveConfig } from "@friend/server";
import { networkInterfaces } from "node:os";
import type { IO } from "../cli";

export type Interfaces = () => ReturnType<typeof networkInterfaces>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** True when only this PC can reach the address Friend listens on. */
export const isLoopbackBind = (bind: string): boolean => LOOPBACK.has(bind);

/** This PC's addresses on the local network (IPv4, not loopback), such as 192.168.1.20. */
export function lanAddresses(ifaces: Interfaces = networkInterfaces): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces())) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal && !out.includes(i.address)) out.push(i.address);
    }
  }
  return out;
}

/** The web addresses Friend can be opened at, for what it listens on. */
export function urlsFor(bind: string, port: number, ifaces: Interfaces = networkInterfaces, https = false): { local: string; network: string[] } {
  const scheme = https ? "https" : "http";
  const local = `${scheme}://127.0.0.1:${port}`;
  if (isLoopbackBind(bind)) return { local, network: [] };
  if (bind === "0.0.0.0" || bind === "::") return { local, network: lanAddresses(ifaces).map((a) => `${scheme}://${a}:${port}`) };
  return { local, network: [`${scheme}://${bind}:${port}`] };
}

const PORT_HELP = "The port must be a whole number from 1024 to 65535.";

function parsePort(v: string | undefined): number {
  const n = Number(v);
  if (v === undefined || v.trim() === "" || !Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(PORT_HELP);
  return n;
}

function show(io: IO, bind: string, port: number, ifaces: Interfaces, https = false): void {
  const u = urlsFor(bind, port, ifaces, https);
  io.out(`Listens on:    ${bind}:${port}`);
  io.out(`On this PC:    ${u.local}`);
  if (u.network.length) for (const n of u.network) io.out(`On your network: ${n}`);
  else if (isLoopbackBind(bind)) io.out("On your network: not reachable (only this PC). Turn it on with: friend lan on");
  else io.out("On your network: no network address found. Check that this PC is connected.");
}

export async function lanCommand(args: string[], io: IO, ifaces: Interfaces = networkInterfaces): Promise<number> {
  const [sub, ...rest] = args;
  const cfg = loadConfig(io.dataDir);
  switch (sub) {
    case undefined:
    case "status":
      show(io, cfg.bind, cfg.port, ifaces, cfg.https);
      io.out(cfg.https ? "Secure (https): on. A phone can use the microphone and camera." : "Secure (https): off. A phone cannot use the microphone or camera. Turn it on with: friend lan https on");
      return 0;

    case "https": {
      if (rest[0] !== "on" && rest[0] !== "off") {
        io.err("Usage: friend lan https on | off");
        return 1;
      }
      cfg.https = rest[0] === "on";
      saveConfig(cfg);
      show(io, cfg.bind, cfg.port, ifaces, cfg.https);
      io.out("");
      io.out("Restart Friend to apply (stop it, then: friend start).");
      if (cfg.https) {
        io.out("Friend makes its own security certificate, so the first time a phone opens the https:// address it shows a warning:");
        io.out("  Android Chrome: Advanced, then Proceed.   iPhone Safari: Show Details, then visit this website.");
        io.out("After that, the microphone and camera work from the phone. Only that address is affected; nothing is installed on the phone.");
        if (isLoopbackBind(cfg.bind)) io.out("Friend is still only reachable from this PC. To open it from a phone too: friend lan on");
      }
      return 0;
    }

    case "on": {
      const portFlag = rest.indexOf("--port");
      if (portFlag >= 0) cfg.port = parsePort(rest[portFlag + 1]);
      cfg.bind = "0.0.0.0";
      if (rest.includes("--https")) cfg.https = true;
      saveConfig(cfg);
      show(io, cfg.bind, cfg.port, ifaces, cfg.https);
      io.out("");
      io.out("Restart Friend to apply (stop it, then: friend start).");
      io.out("Things to know:");
      io.out("  - Anyone on your network can open the sign-in page. Your password and PIN still guard everything; use a strong password.");
      if (cfg.https) {
        io.out("  - Secure (https) is on. The first time a phone opens the address it shows a certificate warning (Advanced, then Proceed); after that the microphone works.");
      } else {
        io.out("  - The connection is plain http: other people on the network could read it. Use it only on a network you trust.");
        io.out("  - Browsers allow the microphone and camera only on localhost or HTTPS, so voice and camera will not work from a phone over plain http. Fix: friend lan https on");
      }
      io.out("  - Windows may ask to allow Node.js through the firewall the first time: allow it on Private networks.");
      io.out("  - Going to a name such as http://my-pc:8787 needs: friend config set allowedHosts my-pc");
      return 0;
    }

    case "off":
      cfg.bind = "127.0.0.1";
      saveConfig(cfg);
      show(io, cfg.bind, cfg.port, ifaces, cfg.https);
      io.out("Restart Friend to apply.");
      return 0;

    case "port": {
      cfg.port = parsePort(rest[0]);
      saveConfig(cfg);
      show(io, cfg.bind, cfg.port, ifaces, cfg.https);
      io.out("Restart Friend to apply.");
      return 0;
    }

    default:
      io.err("Usage: friend lan status | on [--port N] [--https] | off | port N | https on|off");
      return 1;
  }
}
