import { hostname } from "node:os";
import { resolve } from "node:path";
import type { IO } from "../cli";
import { startDeviceNode } from "../node";
import { waitForSignal } from "./start";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function nodeCommand(args: string[], io: IO): Promise<number> {
  const url = flag(args, "url");
  const code = flag(args, "code");
  let token = flag(args, "token");
  if (!url || (!code && !token)) {
    io.err("Usage: friend node --url <ws-url> (--code <code> | --token <token>) [--roots a,b] [--name pc]");
    return 1;
  }
  if (!token && code) {
    const http = url.replace(/^ws/, "http").replace(/\/device\/?$/, "");
    const res = await fetch(`${http}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: flag(args, "name") ?? hostname() }),
    });
    if (!res.ok) {
      io.err(`Pairing failed (${res.status}). Create a fresh code with: friend pair`);
      return 1;
    }
    token = ((await res.json()) as { token: string }).token;
    io.out("Paired. To reconnect later without a code, use:");
    io.out(`  friend node --url ${url} --token ${token}`);
  }
  const roots = (flag(args, "roots") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((r) => resolve(r));
  const node = startDeviceNode({ url, token: token!, roots, onState: (s) => io.out(`device: ${s}`) });
  await node.connected.catch((e: Error) => io.err(e.message));
  await (io.waitForExit ?? waitForSignal)();
  node.stop();
  return 0;
}
