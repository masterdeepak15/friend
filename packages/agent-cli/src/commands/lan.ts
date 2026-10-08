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
export function urlsFor(bind: string, port: number, ifaces: Interfaces = networkInterfaces): { local: string; network: string[] } {
  const local = `http://127.0.0.1:${port}`;
  if (isLoopbackBind(bind)) return { local, network: [] };
  if (bind === "0.0.0.0" || bind === "::") return { local, network: lanAddresses(ifaces).map((a) => `http://${a}:${port}`) };
  return { local, network: [`http://${bind}:${port}`] };
}

const PORT_HELP = "The port must be a whole number from 1024 to 65535.";

function parsePort(v: string | undefined): number {
  const n = Number(v);
  if (v === undefined || v.trim() === "" || !Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(PORT_HELP);
  return n;
}

function show(io: IO, bind: string, port: number, ifaces: Interfaces): void {
  const u = urlsFor(bind, port, ifaces);
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
      show(io, cfg.bind, cfg.port, ifaces);
      return 0;

    case "on": {
      const portFlag = rest.indexOf("--port");
      if (portFlag >= 0) cfg.port = parsePort(rest[portFlag + 1]);
      cfg.bind = "0.0.0.0";
      saveConfig(cfg);
      show(io, cfg.bind, cfg.port, ifaces);
      io.out("");
      io.out("Restart Friend to apply (stop it, then: friend start).");
      io.out("Things to know:");
      io.out("  - Anyone on your network can open the sign-in page. Your password and PIN still guard everything; use a strong password.");
      io.out("  - The connection is plain http: other people on the network could read it. Use it only on a network you trust, or put Friend behind HTTPS (see publicUrl in the README).");
      io.out("  - Browsers allow the microphone and camera only on localhost or HTTPS, so voice and camera will not work from another device over plain http.");
      io.out("  - Windows may ask to allow Node.js through the firewall the first time: allow it on Private networks.");
      io.out("  - Going to a name such as http://my-pc:8787 needs: friend config set allowedHosts my-pc");
      return 0;
    }

    case "off":
      cfg.bind = "127.0.0.1";
      saveConfig(cfg);
      show(io, cfg.bind, cfg.port, ifaces);
      io.out("Restart Friend to apply.");
      return 0;

    case "port": {
      cfg.port = parsePort(rest[0]);
      saveConfig(cfg);
      show(io, cfg.bind, cfg.port, ifaces);
      io.out("Restart Friend to apply.");
      return 0;
    }

    default:
      io.err("Usage: friend lan status | on [--port N] | off | port N");
      return 1;
  }
}
