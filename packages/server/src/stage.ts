import {
  StageCommand,
  TOOL_DEFS,
  type SceneMode,
  type ServerMsg,
  type StageObject,
  type StageSnapshot,
  type ToolResult,
} from "@friend/protocol";

const MAX_OBJECTS = 12;

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

  /** One-line summary for the system prompt. */
  summary(): string {
    const s = this.snapshot();
    const ids = s.objects.map((o) => `${o.id}(${o.type})`).join(", ") || "nothing";
    return `scene=${s.scene}; on screen: ${ids}; presence=${s.presence.state}`;
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
  const applied = stage.apply(cmd.data);
  if (!applied.ok) return { ok: false, error: applied.error };
  emit({ type: "stage", command: cmd.data });
  return { ok: true, output: "ok", truncated: false };
}
