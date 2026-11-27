import { NO_PC_PERMISSIONS, PcPermissions, type PcDown, type PcStatus } from "@friend/protocol";
import { Control, type Phase } from "./control";
import type { Helper } from "./helper";
import { Link, type LinkState, type WsLike } from "./link";
import { Session, signIn, type Tokens } from "./signin";
import { StatusKeeper } from "./status";
import { AgentStore, type Sealer } from "./store";
import { Tasks } from "./tasks";
import { Terms } from "./term";
import { runTool, type PcToolDeps } from "./tools";

export interface AgentOptions {
  store: AgentStore;
  helper: Helper;
  server: string;
  version: string;
  os: string;
  host: string;
  /** Opens the WebSocket to Friend with the access token. */
  connect(url: string, token: string): WsLike;
  /** Shows the owner the approval page (opens the browser and prints the code). */
  show(url: string, code: string): void;
  fetch?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** The agent was revoked: it signed out and stopped. */
  onRevoked?: () => void;
  /** Friend says a newer agent.js exists: download it, check its hash, replace it and restart. */
  onUpdate?: (url: string, sha256: string) => void;
  log?: (line: string) => void;
  /** The SHA-256 of the agent.js that is running, so Friend can tell when a newer one exists. */
  agentSha256?: string;
  /** Sign-in needs these the first time only. */
  enrollmentId?: string;
  random?: () => number;
}

const phaseState = (p: Phase, taskRunning: boolean): PcStatus["state"] => (p === "active" ? "controlling" : p === "paused" ? "paused" : p === "countdown" ? "waiting" : taskRunning ? "waiting" : "idle");

/** The program that runs on the PC: it signs in once, stays connected to Friend, and does what Friend asks with the permissions the owner chose. */
export class PcAgent {
  readonly session: Session;
  readonly control: Control;
  readonly tasks: Tasks;
  readonly status: StatusKeeper;
  readonly terms: Terms;
  private readonly link: Link;
  private readonly sealer: Sealer;
  private permissions: PcPermissions;
  private stopped = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly log: (line: string) => void;

  constructor(private readonly o: AgentOptions) {
    this.now = o.now ?? Date.now;
    this.setTimer =
      o.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
    this.log = o.log ?? (() => {});
    this.sealer = { seal: async (p) => (await o.helper.call("seal", { text: p })).text, unseal: async (s) => (await o.helper.call("unseal", { text: s })).text };
    this.session = new Session(o.store, this.sealer, o.server, this.now, o.fetch);
    this.permissions = this.loadPermissions();

    this.status = new StatusKeeper({ store: o.store, push: (s) => void this.link.send({ type: "status", status: s }), now: this.now, setTimer: this.setTimer });
    this.tasks = new Tasks(o.store);
    this.tasks.resumeAfterRestart();
    this.terms = new Terms({ helper: o.helper, onCount: (n) => this.status.set({ sessions: n }) });
    this.control = new Control({
      now: this.now,
      setTimer: this.setTimer,
      onChange: (phase, why) => this.onPhase(phase, why),
    });
    this.link = new Link({
      getAccess: () => this.session.access(),
      refresh: () => this.session.refresh(),
      onMessage: (m) => void this.onMessage(m),
      onState: (s) => this.onLink(s),
      connect: (token) => o.connect(`${o.server.replace(/^http/, "ws").replace(/\/+$/, "")}/pc`, token),
      setTimer: this.setTimer,
      ...(o.random ? { random: o.random } : {}),
    });
  }

  private loadPermissions(): PcPermissions {
    try {
      const p = PcPermissions.safeParse(JSON.parse(this.o.store.get("permissions") ?? "null"));
      if (p.success) return p.data;
    } catch {
      /* none yet */
    }
    return NO_PC_PERMISSIONS;
  }

  private setPermissions(p: PcPermissions): void {
    this.permissions = p;
    this.o.store.set("permissions", JSON.stringify(p));
  }

  /** Signs in when this PC never did (the owner approves a code), then connects and stays connected. */
  async start(): Promise<void> {
    this.stopped = false;
    this.o.helper.call("ping").catch(() => {}); // warm the helper up (it takes a few seconds to compile)
    if (!(await this.session.signedIn())) {
      if (!this.o.enrollmentId) throw new Error("This PC is not signed in. Run the install command from Friend again (Plugins, Windows PCs, Add PC).");
      const tokens: Tokens = await signIn({ server: this.o.server, enrollmentId: this.o.enrollmentId, os: this.o.os, host: this.o.host, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), show: this.o.show });
      await this.session.save(tokens);
      this.log("signed in");
    }
    this.status.start();
    this.link.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.status.stop();
    this.control.end("the agent stopped");
    this.link.stop();
    await this.terms.closeAll();
    this.o.helper.stop();
  }

  /** What the helper reports on its own. */
  onHelperEvent(event: string, data: Record<string, unknown>): void {
    if (event === "human") {
      if (this.control.phase() === "active" || this.control.phase() === "countdown") {
        this.control.humanInput();
        this.link.send({ type: "human.input" });
      }
    } else if (event === "hotkey") {
      if (this.control.phase() !== "idle") {
        this.control.end("stopped with the hotkey");
        this.link.send({ type: "lease.ended", reason: "the person at the PC pressed the stop hotkey" });
      }
    } else if (event.startsWith("term.")) this.terms.onEvent(event, data);
  }

  private onLink(s: LinkState): void {
    this.log(`link ${s}`);
    if (s === "online") {
      this.link.send({ type: "hello", os: this.o.os, host: this.o.host, version: this.o.version, ...(this.o.agentSha256 ? { agentSha256: this.o.agentSha256 } : {}) });
      this.link.send({ type: "status", status: this.status.current() });
    } else if (s === "offline") {
      // Friend cannot see us: nothing may go on moving the mouse
      if (this.control.phase() !== "idle") this.control.end("the connection to Friend was lost");
    } else if (s === "revoked") {
      void this.revoked();
    }
  }

  private async revoked(): Promise<void> {
    this.log("revoked");
    await this.session.clear();
    this.control.end("this PC was revoked");
    await this.terms.closeAll();
    this.status.set({ state: "error", last: "revoked by the owner" });
    this.o.helper.call("overlay", { show: false }).catch(() => {});
    this.o.onRevoked?.();
  }

  private onPhase(phase: Phase, why: string): void {
    this.status.set({ state: phaseState(phase, !!this.tasks.current()), last: why });
    const banner = phase === "countdown" ? "Friend is about to take control of this PC" : phase === "active" ? `Friend is controlling this PC${this.tasks.current() ? `: ${this.tasks.current()!.title}` : ""}  |  stop: Ctrl+Alt+Shift+Esc` : phase === "paused" ? "Paused: you took over. Friend will ask before it goes on" : "";
    void this.o.helper.call("overlay", { show: phase !== "idle", text: banner, color: phase === "paused" ? "#e6c200" : "#ff8c00" }).catch(() => {});
    if (phase === "idle") this.link.send({ type: "lease.ended", reason: why });
  }

  private async onMessage(m: PcDown): Promise<void> {
    if (this.stopped) return;
    switch (m.type) {
      case "permissions":
        this.setPermissions(m.permissions);
        return;
      case "lease.start": {
        const r = this.control.start(m.minutes);
        if (!r.ok) this.log(r.error);
        return;
      }
      case "lease.end":
        this.control.end("ended by Friend");
        return;
      case "revoke":
        await this.revoked();
        return;
      case "update":
        this.o.onUpdate?.(m.url, m.sha256);
        return;
      case "tool.exec": {
        if (m.permissions) this.setPermissions(m.permissions);
        const deps: PcToolDeps = { helper: this.o.helper, control: this.control, tasks: this.tasks, store: this.o.store, status: this.status, perms: () => this.permissions, terms: this.terms };
        const out = await runTool(deps, m.tool, m.args, m.approved === true);
        if (out.ok) this.link.send({ type: "tool.result", id: m.id, result: { output: out.output, truncated: out.truncated, ...(out.image ? { image: out.image } : {}) } });
        else this.link.send({ type: "tool.error", id: m.id, error: out.error, ...(out.needsApproval ? { needsApproval: out.needsApproval } : {}) });
        return;
      }
    }
  }
}
