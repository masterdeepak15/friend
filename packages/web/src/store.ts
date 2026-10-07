import {
  ServerMsg,
  type PendingApproval,
  type PresenceState,
  type SceneMode,
  type StageObject,
} from "@friend/protocol";

export type Connection = "connecting" | "open" | "closed" | "unauthorized";

export interface Alert {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
}

export interface StageViewState {
  scene: SceneMode;
  objects: StageObject[];
  captions: string;
  captionDone: boolean;
  presence: { state: PresenceState; style: string; amplitude: number; pulse: number };
  mood: { accent: string; intensity: number };
  approval: PendingApproval | null;
  alerts: Alert[];
  connection: Connection;
  busy: boolean;
  deviceOnline: boolean;
}

export const initialState: StageViewState = {
  scene: "conversation",
  objects: [],
  captions: "",
  captionDone: true,
  presence: { state: "idle", style: "sphere", amplitude: 0, pulse: 0 },
  mood: { accent: "#3fd8ff", intensity: 0.6 },
  approval: null,
  alerts: [],
  connection: "connecting",
  busy: false,
  deviceOnline: false,
};

export type LocalAction =
  | { type: "conn"; value: Connection }
  | { type: "alert.dismiss"; id: number };

let alertSeq = 0;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function applyStage(s: StageViewState, cmd: Extract<ServerMsg, { type: "stage" }>["command"]): StageViewState {
  switch (cmd.cmd) {
    case "scene":
      return { ...s, scene: cmd.mode };
    case "show": {
      const i = s.objects.findIndex((o) => o.id === cmd.object.id);
      const objects = i === -1 ? [...s.objects, cmd.object] : s.objects.map((o, k) => (k === i ? cmd.object : o));
      return { ...s, objects };
    }
    case "update":
      return { ...s, objects: s.objects.map((o) => (o.id === cmd.id ? { ...o, props: { ...o.props, ...cmd.props } } : o)) };
    case "hide":
      return { ...s, objects: s.objects.filter((o) => o.id !== cmd.id) };
    case "clear":
      return { ...s, objects: [], scene: "conversation" };
    case "presence":
      return {
        ...s,
        presence: { ...s.presence, state: cmd.state ?? s.presence.state, style: cmd.style ?? s.presence.style },
      };
    case "mood":
      return { ...s, mood: { accent: cmd.accent ?? s.mood.accent, intensity: cmd.intensity ?? s.mood.intensity } };
  }
}

/** Pure reducer for everything the stage shows. Unknown or invalid input leaves the state unchanged. */
export function reduce(state: StageViewState, input: unknown): StageViewState {
  const local = input as LocalAction | null;
  if (local && typeof local === "object") {
    if (local.type === "conn") return { ...state, connection: local.value };
    if (local.type === "alert.dismiss") return { ...state, alerts: state.alerts.filter((a) => a.id !== local.id) };
  }
  const parsed = ServerMsg.safeParse(input);
  if (!parsed.success) return state;
  const m = parsed.data;
  switch (m.type) {
    case "snapshot":
      return {
        ...state,
        scene: m.stage.scene,
        objects: m.stage.objects,
        presence: { ...state.presence, state: m.stage.presence.state, style: m.stage.presence.style },
        mood: m.stage.mood,
        approval: m.pendingApproval ?? null,
      };
    case "stage":
      return applyStage(state, m.command);
    case "caption.delta": {
      const fresh = state.captionDone;
      return {
        ...state,
        captions: (fresh ? "" : state.captions) + m.text,
        captionDone: false,
        presence: { ...state.presence, amplitude: clamp01(0.3 + m.text.length * 0.04), pulse: state.presence.pulse + 1 },
      };
    }
    case "caption.end":
      return { ...state, captionDone: true, presence: { ...state.presence, amplitude: 0 } };
    case "approval.request": {
      const { type: _t, ...approval } = m;
      return { ...state, approval };
    }
    case "approval.resolved":
      return state.approval?.id === m.id ? { ...state, approval: null } : state;
    case "alert":
      return { ...state, alerts: [...state.alerts.slice(-3), { id: ++alertSeq, level: m.level, text: m.text }] };
    case "status":
      return { ...state, busy: m.busy, deviceOnline: m.deviceOnline };
    case "error":
      return { ...state, alerts: [...state.alerts.slice(-3), { id: ++alertSeq, level: "error", text: m.message }] };
  }
}
