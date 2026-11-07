import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const refuse = (): never => {
  throw new Error("The built-in sandbox has no network.");
};

/**
 * Called first in the sandbox process, before any program text runs. The process already cannot read files outside the engine folders,
 * start programs or start threads (Node's permission model) and has an empty environment; this also removes the network, so a program
 * that reaches Node through an engine's bridge (Python's `js` module) finds the network modules switched off.
 */
export function lockDownNetwork(): void {
  const g = globalThis as Record<string, unknown>;
  for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "XMLHttpRequestUpload"]) {
    try {
      delete g[name];
    } catch {
      g[name] = undefined;
    }
  }
  const set = (target: object, key: string) => {
    try {
      Object.defineProperty(target, key, { value: refuse, writable: false, configurable: false });
    } catch {
      /* not there on this Node version */
    }
  };
  for (const k of ["connect", "createConnection", "createServer"]) set(net, k);
  set(net.Socket.prototype, "connect");
  set(net.Server.prototype, "listen");
  for (const k of ["connect"]) set(tls, k);
  for (const k of ["createSocket"]) set(dgram, k);
  // the classes behind the functions too: a program that reaches Node can build a socket or a resolver without the helper functions
  for (const k of ["bind", "connect", "send"]) set(dgram.Socket.prototype, k);
  for (const k of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse", "setServers"]) {
    set(dns.Resolver.prototype, k);
    set(dns.promises.Resolver.prototype, k);
  }
  set(dns, "setServers");
  for (const k of ["request", "get", "createServer"]) {
    set(http, k);
    set(https, k);
  }
  for (const k of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveMx", "resolveTxt", "resolveSrv", "reverse"]) {
    set(dns, k);
    set(dns.promises, k);
  }
  syncBuiltinESMExports();
}
