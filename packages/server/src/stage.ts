import {
  StageCommand,
  TOOL_DEFS,
  type SceneMode,
  type ServerMsg,
  type StageObject,
  type StageSnapshot,
  type ToolResult,
} from "@friend/protocol";

import { describeScreen, placeObject, type PanelName } from "./agent/layout";
import type { LookConfig } from "./config";

const MAX_OBJECTS = 12;
/** Largest page the agent may draw in a sandbox object. */
export const MAX_SANDBOX_HTML = 100_000;

/** A sandbox page must be text and small; other object types are rendered as data and need no check. */
function sandboxError(type: string, props: Record<string, unknown>, requireHtml: boolean): string | null {
  if (type !== "sandbox") return null;
  if (!("html" in props) && !requireHtml) return null;
  const html = props.html;
  if (typeof html !== "string") return "A sandbox object needs its page as text in props.html.";
  if (html.length > MAX_SANDBOX_HTML) return `A sandbox page can be at most ${MAX_SANDBOX_HTML} characters.`;
  return null;
}

export type ApplyResult = { ok: true } | { ok: false; error: string };

export class StageState {
  private scene: SceneMode = "conversation";
  private objects = new Map<string, { obj: StageObject; expiresAt: number | null }>();
  private presence: StageSnapshot["presence"] = { state: "idle", style: "sphere" };
  private mood: StageSnapshot["mood"] = { accent: "#3fd8ff", intensity: 0.6 };

  apply(cmd: StageCommand, now: number = Date.now()): ApplyResult {
    switch (cmd.cmd) {
      case "scene":
        this.scene = cmd.mode;
        return { ok: true };
      case "show": {
        const bad = sandboxError(cmd.object.type, cmd.object.props, true);
        if (bad) return { ok: false, error: bad };
        const isNew = !this.objects.has(cmd.object.id);
        if (isNew && this.objects.size >= MAX_OBJECTS) {
          return { ok: false, error: `Too many objects on screen (limit ${MAX_OBJECTS}). Hide something first.` };
        }
        const expiresAt = cmd.object.ttl ? now + cmd.object.ttl * 1000 : null;
        this.objects.set(cmd.object.id, { obj: cmd.object, expiresAt });
        return { ok: true };
      }
      case "update": {
        const e = this.objects.get(cmd.id);
        if (!e) return { ok: false, error: `No object with id "${cmd.id}" is on screen` };
        const bad = sandboxError(e.obj.type, cmd.props, false);
        if (bad) return { ok: false, error: bad };
        e.obj = { ...e.obj, props: { ...e.obj.props, ...cmd.props } };
        return { ok: true };
      }
      case "hide":
        if (!this.objects.delete(cmd.id)) return { ok: false, error: `No object with id "${cmd.id}" is on screen` };
        return { ok: true };
      case "clear":
        this.objects.clear();
        this.scene = "conversation";
        return { ok: true };
      case "presence":
        if (cmd.state) this.presence.state = cmd.state;
        if (cmd.style) this.presence.style = cmd.style;
        return { ok: true };
      case "mood":
        if (cmd.accent) this.mood.accent = cmd.accent;
        if (cmd.intensity !== undefined) this.mood.intensity = cmd.intensity;
        return { ok: true };
    }
  }

  /** Remove objects whose ttl elapsed; returns the removed ids. */
  expire(now: number = Date.now()): string[] {
    const gone: string[] = [];
    for (const [id, e] of this.objects) {
      if (e.expiresAt !== null && e.expiresAt <= now) {
        this.objects.delete(id);
        gone.push(id);
      }
    }
    return gone;
  }

  snapshot(): StageSnapshot {
    return {
      scene: this.scene,
      objects: [...this.objects.values()].map((e) => e.obj),
      presence: { ...this.presence },
      mood: { ...this.mood },
    };
  }

  /** What the model is told about the screen with each request: what is where, how long it stays, and what is free. */
  summary(now: number = Date.now()): string {
    return describeScreen(this.scene, this.presence.state, [...this.objects.values()].map((e) => ({ object: e.obj, expiresAt: e.expiresAt })), now, this.panels);
  }

  private panels: PanelName[] = [];
  private locked = false;

  /** Takes the owner's chosen style, colour and brightness as the current look; returns the commands that tell the screens. */
  setLook(look: LookConfig): StageCommand[] {
    this.presence.style = look.style;
    this.mood.accent = look.accent;
    this.mood.intensity = look.intensity;
    this.locked = !look.aiMayChange;
    return [
      { cmd: "presence", style: look.style },
      { cmd: "mood", accent: look.accent, intensity: look.intensity },
    ];
  }

  /** The owner fixed the look: the AI may not change the style, colour or brightness. */
  looksLocked(): boolean {
    return this.locked;
  }

  /** The side panels the owner has open right now; objects are kept out of their way. */
  setPanels(open: readonly string[]): void {
    this.panels = (["chat", "tasks"] as const).filter((p) => open.includes(p));
  }

  openPanels(): PanelName[] {
    return [...this.panels];
  }
}

export function runStageTool(
  name: string,
  args: unknown,
  stage: StageState,
  emit: (m: ServerMsg) => void,
): ToolResult {
  const def = TOOL_DEFS.find((t) => t.name === name && t.target === "gateway");
  if (!def) return { ok: false, error: `Unknown stage tool: ${name}` };
  const input = def.input.safeParse(args ?? {});
  if (!input.success) return { ok: false, error: `Invalid arguments for ${name}: ${input.error.message}` };
  const cmd = StageCommand.safeParse({ cmd: name.slice("stage.".length), ...(input.data as object) });
  if (!cmd.success) return { ok: false, error: `Invalid stage command: ${cmd.error.message}` };
  let command = cmd.data;
  let note: string | undefined;
  if (stage.looksLocked()) {
    const fixed = "ok. The owner has fixed the look of the presence (style, colour and brightness), so that part was not changed.";
    if (command.cmd === "mood" && (command.accent !== undefined || command.intensity !== undefined)) return { ok: true, output: fixed, truncated: false };
    if (command.cmd === "presence" && command.style !== undefined) {
      const { style: _kept, ...rest } = command;
      if (rest.state === undefined) return { ok: true, output: fixed, truncated: false };
      command = rest;
      note = fixed;
    }
  }
  if (command.cmd === "show") {
    // never let a new object land on top of another one or on the always-visible parts of the screen
    const placed = placeObject(command.object, stage.snapshot().objects, stage.openPanels());
    command = { cmd: "show", object: placed.object };
    note = placed.note;
  }
  const applied = stage.apply(command);
  if (!applied.ok) return { ok: false, error: applied.error };
  emit({ type: "stage", command });
  return { ok: true, output: note ? `ok. ${note}` : "ok", truncated: false };
}
