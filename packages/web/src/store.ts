import {
  ServerMsg,
  type PendingApproval,
  type PresenceState,
  type PresenceStyle,
  type SceneMode,
  type StageObject,
  type ViewPreset,
  type ClientLook,
} from "@friend/protocol";

/** "elsewhere": Friend is open in another window; this one waits for "Use here". */
export type Connection = "connecting" | "open" | "closed" | "unauthorized" | "elsewhere";

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
  /** The conversation so far, oldest first (what was said or typed, and what Friend answered). */
  chat: ChatLine[];
  /** The last chat line is an answer that is still being written. */
  chatLive: boolean;
  /** What the owner wants on the screen besides the AI's pictures. */
  view: ViewPreset;
  /** The owner's choices for the presence's size and reactions, the glow, and the captions. */
  look: ClientLook;
  /** The server has told us which view the owner chose (until then the corner widgets are not drawn, so they never flash up and vanish). */
  viewKnown: boolean;
  busy: boolean;
  /** What Friend says it is doing right now (null when nothing). */
  activity: string | null;
  deviceOnline: boolean;
  voice: VoiceView;
  /** A borderline voice waiting for the owner's PIN. */
  challenge: VoiceChallenge | null;
  camera: CameraView;
  /** Who spoke last and how well they were recognized (null until someone has spoken). `seq` changes with every utterance. */
  speaker: { name: string | null; trust: "owner" | "member" | "guest" | "unverified"; seq: number } | null;
  /** What the profile badge calls the owner (empty: "Owner"). */
  ownerName: string;
}

export const DEFAULT_CLIENT_LOOK: ClientLook = { size: 1, reactivity: 0.7, ambient: true, captions: true, captionSize: "medium" };

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
  chat: [],
  chatLive: false,
  view: "companion",
  look: DEFAULT_CLIENT_LOOK,
  viewKnown: false,
  busy: false,
  activity: null,
  deviceOnline: false,
  voice: { mode: "idle", level: 0, available: false, enrolled: false },
  challenge: null,
  camera: { enabled: false, stream: null },
  speaker: null,
  ownerName: "",
};

export interface ChatLine {
  role: "user" | "assistant";
  text: string;
}

const MAX_CHAT_LINES = 200;
const capChat = (lines: ChatLine[]) => (lines.length > MAX_CHAT_LINES ? lines.slice(-MAX_CHAT_LINES) : lines);

export type LocalAction =
  | { type: "chat.seed"; lines: ChatLine[] }
  | { type: "conn"; value: Connection }
  | { type: "alert.dismiss"; id: number }
  | { type: "object.dismiss"; id: string }
  | { type: "object.place"; id: string; placement: StageObject["placement"] }
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
      return { ...s, objects: s.objects.filter((o) => o.pinned), scene: "conversation" }; // the owner's widgets stay
    case "pin":
      return { ...s, objects: s.objects.map((o) => (o.id === cmd.id ? { ...o, pinned: true } : o)) };
    case "unpin":
      return { ...s, objects: s.objects.map((o) => (o.id === cmd.id ? (({ pinned: _p, ...rest }) => rest)(o) : o)) };
    case "place":
      return { ...s, objects: s.objects.map((o) => (o.id === cmd.id ? { ...o, placement: cmd.placement } : o)) };
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
    if (local.type === "chat.seed") {
      // earlier conversation, loaded once when the screen opens; lines that arrived live meanwhile stay after it
      const lines = Array.isArray(local.lines) ? local.lines : [];
      return state.chat.length === 0 ? { ...state, chat: capChat(lines) } : { ...state, chat: capChat([...lines, ...state.chat]) };
    }
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
    if (local.type === "object.place") return { ...state, objects: state.objects.map((o) => (o.id === local.id ? { ...o, placement: local.placement } : o)) };
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
    case "chat.user":
      return { ...state, chat: capChat([...state.chat, { role: "user", text: m.text }]), chatLive: false };
    case "ui":
      return { ...state, view: m.view, look: m.look ?? state.look, ownerName: m.ownerName ?? state.ownerName, viewKnown: true };
    case "caption.delta": {
      const fresh = state.captionDone;
      const last = state.chat.at(-1);
      const chat =
        state.chatLive && last?.role === "assistant"
          ? [...state.chat.slice(0, -1), { role: "assistant" as const, text: last.text + m.text }]
          : capChat([...state.chat, { role: "assistant" as const, text: m.text }]);
      return {
        ...state,
        chat,
        chatLive: true,
        captions: (fresh ? "" : state.captions) + m.text,
        captionDone: false,
        presence: { ...state.presence, amplitude: clamp01(0.3 + m.text.length * 0.04), pulse: state.presence.pulse + 1 },
      };
    }
    case "caption.end":
      return { ...state, chatLive: false, captionDone: true, presence: { ...state.presence, amplitude: 0 } };
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
      return {
        ...state,
        captions: m.trust === "guest" ? `Guest: ${m.text}` : m.trust === "member" && m.speaker ? `${m.speaker}: ${m.text}` : m.text,
        captionDone: true,
        speaker: { name: m.trust === "member" ? (m.speaker ?? null) : null, trust: m.trust ?? "unverified", seq: (state.speaker?.seq ?? 0) + 1 },
      };
    case "voice.challenge":
      return { ...state, challenge: { id: m.id, text: m.text } };
    case "voice.challenge.end":
      return state.challenge?.id === m.id ? { ...state, challenge: null } : state;
    case "audio.chunk":
    case "audio.stop":
      return state; // handled by the audio player, outside the reducer
    case "camera.request":
    case "camera.cancel":
    case "screen.request":
    case "screen.cancel":
      return state; // handled by the camera controller, outside the reducer
  }
}
