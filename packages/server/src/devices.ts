import { DeviceUp, type ToolResult } from "@friend/protocol";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { Device } from "./auth";

interface Pending {
  resolve: (r: ToolResult) => void;
  timer: NodeJS.Timeout;
  deviceId: number;
}

export class DeviceHub {
  private sockets = new Map<number, WebSocket>();
  private pending = new Map<string, Pending>();
  private listeners = new Set<(online: boolean) => void>();

  onChange(cb: (online: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const l of this.listeners) l(this.hasOnline());
  }

  attach(device: Device, ws: WebSocket): void {
    this.sockets.get(device.id)?.close(4000, "replaced");
    this.sockets.set(device.id, ws);
    ws.on("message", (data) => {
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        return;
      }
      const msg = DeviceUp.safeParse(json);
      if (!msg.success) return;
      const p = this.pending.get(msg.data.id);
      if (!p || p.deviceId !== device.id) return;
      this.pending.delete(msg.data.id);
      clearTimeout(p.timer);
      if (msg.data.type === "tool.result") {
        p.resolve({ ok: true, output: msg.data.result.output, truncated: msg.data.result.truncated });
      } else p.resolve({ ok: false, error: msg.data.error });
    });
    ws.on("close", () => {
      if (this.sockets.get(device.id) === ws) this.sockets.delete(device.id);
      for (const [id, p] of this.pending) {
        if (p.deviceId !== device.id) continue;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: "device disconnected" });
      }
      this.notify();
    });
    ws.on("error", () => {});
    ws.send(JSON.stringify({ type: "hello" }));
    this.notify();
  }

  hasOnline(): boolean {
    return this.sockets.size > 0;
  }

  exec(tool: string, args: unknown, timeoutMs: number, opts: { approvedOutside?: boolean } = {}): Promise<ToolResult> {
    const entry = [...this.sockets.entries()].at(-1);
    if (!entry) return Promise.resolve({ ok: false, error: "no device online" });
    const [deviceId, ws] = entry;
    const id = randomUUID();
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `device call timed out after ${timeoutMs} ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, deviceId });
      ws.send(JSON.stringify({ type: "tool.exec", id, tool, args, approvedOutside: opts.approvedOutside }));
    });
  }
}
