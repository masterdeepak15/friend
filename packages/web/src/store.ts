import {
  ServerMsg,
  type PendingApproval,
  type PresenceState,
  type PresenceStyle,
  type SceneMode,
  type StageObject,
} from "@friend/protocol";

export type Connection = "connecting" | "open" | "closed" | "unauthorized";

export interface Alert {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
}

export type VoiceMode = "idle" | "listening" | "transcribing" | "speaking";

export interface VoiceView {
  mode: VoiceMode;
  /** Live microphone or playback loudness, 0..1. */
  level: number;
  available: boolean;
  /** The owner's voice has been enrolled, so strangers are recognized. */
  enrolled: boolean;
}

export interface VoiceChallenge {
  id: string;
  text: string;
}

export interface CameraView {
  /** The owner's switch. It is not remembered: a reload turns the camera off again. */
  enabled: boolean;
  /** The live stream while the camera is open for a picture, otherwise null. */
  stream: MediaStream | null;
}

export interface StageViewState {
  scene: SceneMode;
  objects: StageObject[];
  captions: string;
  captionDone: boolean;
  presence: { state: PresenceState; style: PresenceStyle; amplitude: number; pulse: number };
  mood: { accent: string; intensity: number };
  approval: PendingApproval | null;
  alerts: Alert[];
  connection: Connection;
  busy: boolean;
  /** What Friend says it is doing right now (null when nothing). */
  activity: string | null;
  deviceOnline: boolean;
  voice: VoiceView;
  /** A borderline voice waiting for the owner's PIN. */
  challenge: VoiceChallenge | null;
  camera: CameraView;
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
  activity: null,
  deviceOnline: false,
  voice: { mode: "idle", level: 0, available: false, enrolled: false },
  challenge: null,
  camera: { enabled: false, stream: null },
};

export type LocalAction =
  | { type: "conn"; value: Connection }
  | { type: "alert.dismiss"; id: number }
  | { type: "object.dismiss"; id: string }
  | { type: "alert.add"; level: "info" | "warn" | "error"; text: string }
  | { type: "challenge.dismiss"; id: string }
  | { type: "camera.enable"; value: boolean }
  | { type: "camera.open"; stream: MediaStream }
  | { type: "camera.closed" }
  | { type: "voice.mode"; mode: VoiceMode }
  | { type: "voice.level"; level: number };

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
    if (local.type === "alert.add") {
      return { ...state, alerts: [...state.alerts.slice(-3), { id: ++alertSeq, level: local.level, text: local.text }] };
    }
    if (local.type === "camera.enable") {
      // switching off also drops any preview that is showing
      return { ...state, camera: { enabled: local.value, stream: local.value ? state.camera.stream : null } };
    }
    if (local.type === "camera.open") return { ...state, camera: { ...state.camera, stream: local.stream } };
    if (local.type === "camera.closed") return { ...state, camera: { ...state.camera, stream: null } };
    if (local.type === "challenge.dismiss") {
      return state.challenge?.id === local.id ? { ...state, challenge: null } : state;
    }
    if (local.type === "voice.mode") {
      return { ...state, voice: { ...state.voice, mode: local.mode, level: local.mode === "idle" ? 0 : state.voice.level } };
    }
    if (local.type === "voice.level") {
      const level = Number.isFinite(local.level) ? Math.min(1, Math.max(0, local.level)) : 0;
      return { ...state, voice: { ...state.voice, level } };
    }
    if (local.type === "object.dismiss") return { ...state, objects: state.objects.filter((o) => o.id !== local.id) };
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
    case "activity":
      return { ...state, activity: m.text };
    case "status":
      return {
        ...state,
        busy: m.busy,
        activity: m.busy ? state.activity : null,
        deviceOnline: m.deviceOnline,
        voice: {
          ...state.voice,
          available: m.voiceAvailable ?? state.voice.available,
          enrolled: m.voiceEnrolled ?? state.voice.enrolled,
        },
      };
    case "error":
      return { ...state, alerts: [...state.alerts.slice(-3), { id: ++alertSeq, level: "error", text: m.message }] };
    case "voice.heard":
      return { ...state, captions: m.trust === "guest" ? `Guest: ${m.text}` : m.text, captionDone: true };
    case "voice.challenge":
      return { ...state, challenge: { id: m.id, text: m.text } };
    case "voice.challenge.end":
      return state.challenge?.id === m.id ? { ...state, challenge: null } : state;
    case "audio.chunk":
    case "audio.stop":
      return state; // handled by the audio player, outside the reducer
    case "camera.request":
    case "camera.cancel":
      return state; // handled by the camera controller, outside the reducer
  }
}
