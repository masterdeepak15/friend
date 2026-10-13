import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { LoginScreen } from "./auth/LoginScreen";
import { SetupScreen } from "./auth/SetupScreen";
import { ConnectorsPanel } from "./connectors/ConnectorsPanel";
import { buildSlash } from "./input/appCommands";
import type { SlashCommand } from "./input/commands";
import { HelpPanel } from "./input/HelpPanel";
import { useCoarsePointer } from "./input/useCoarsePointer";
import { ChatPanel } from "./layout/ChatPanel";
import { resetPositions, usePanels } from "./layout/prefs";
import { TasksPanel } from "./layout/TasksPanel";
import { OwnerMenu } from "./overlay/OwnerMenu";
import { readMenuStyle, saveMenuStyle, type MenuStyle } from "./overlay/menuShared";
import { OrbMenu, type OrbMenuProps } from "./orb/OrbMenu";
import type { SettingsTab } from "./settings/tabs";
import { Overlay } from "./overlay/Overlay";
import { describeStatus } from "./overlay/StatusBadge";
import { PluginsPanel } from "./plugins/PluginsPanel";
import { httpSettingsApi } from "./settings/settingsApi";
import { SettingsPanel } from "./settings/SettingsPanel";
import { Stage } from "./stage/Stage";
import { useFriend } from "./useFriend";
import { EnrollmentFlow } from "./voice/EnrollmentFlow";
import { useVoiceKeys } from "./voice/keys";
import { useAudioUnlock } from "./voice/unlock";
import { ElsewhereCard } from "./overlay/ElsewhereCard";
import { useScreenReport } from "./layout/screen";
import { HouseholdPanel } from "./voice/HouseholdPanel";
import { QuickLaunch, type LauncherItem } from "./hud/QuickLaunch";
import { MusicPlayerView } from "./music/MusicPlayer";
import { commandToAction, useMusicPlayer } from "./music/useMusicPlayer";
import { useRemoteMusic } from "./music/useRemoteMusic";
import { musicReturnNotice } from "./music/returnNotice";

type Phase = "loading" | "setup" | "login" | "stage";

export function StageApp({ onSignedOut }: { onSignedOut: () => void }) {
  const { state, send, dispatch, voice, handsFree, useHere } = useFriend(onSignedOut);
  useVoiceKeys(voice);
  useAudioUnlock(voice);
  useScreenReport(send, state.connection);
  const [muted, setMuted] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [household, setHousehold] = useState(false);
  const [managingPlugins, setManagingPlugins] = useState(false);
  const [pluginFocus, setPluginFocus] = useState<string | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState<null | SettingsTab>(null);
  const [menuStyle, setMenuStyle] = useState<MenuStyle>(readMenuStyle);
  const switchMenu = (style: MenuStyle) => {
    saveMenuStyle(style);
    setMenuStyle(style);
  };
  const MenuTag: ComponentType<OrbMenuProps> = menuStyle === "orb" ? OrbMenu : (OwnerMenu as ComponentType<OrbMenuProps>);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [menuRequest, setMenuRequest] = useState(0);
  const [help, setHelp] = useState<SlashCommand[] | null>(null);
  const panels = usePanels(state.view);
  // The player lives here, not in its panel, so it keeps playing (and the assistant keeps control) while the panel is hidden.
  // When the owner chose the PC's speakers, the PC plays and this player only shows it and sends it the button presses.
  const remote = state.music?.output === "host";
  const localPlayer = useMusicPlayer({ music: state.music, cmd: state.musicCmd, send, connection: state.connection, remote });
  const remotePlayer = useRemoteMusic({ local: localPlayer, host: state.hostMusic, send });
  const player = remote ? remotePlayer : localPlayer;
  const animations = state.hud?.animations ?? "full";
  const launch = (item: LauncherItem) => {
    const { type, value } = item.action;
    if (type === "url") window.open(value, "_blank", "noopener,noreferrer");
    else if (type === "prompt") send({ type: "chat.send", text: value });
    else if (type === "music" || (type === "panel" && value === "music")) {
      if (!state.music?.folderSet) {
        dispatch({ type: "alert.add", level: "info", text: "No music folder is chosen yet. Pick one in Settings, Widgets, and the player opens." });
        setSettingsOpen("widgets");
        return;
      }
      if (type === "panel") {
        panels.toggle("music", true);
        if (player.state.view === "hidden") player.dispatch({ type: "view", view: "mini" });
        return;
      }
      const action = commandToAction({ action: value } as Parameters<typeof commandToAction>[0]);
      if (action) player.dispatch(action);
    } else if (value === "plugins") setManagingPlugins(true);
    else if (value === "settings") setSettingsOpen("model");
    else if (value === "chat" || value === "tasks") panels.toggle(value, true);

  };
  const shown = useMemo(() => (muted ? { ...state, objects: [], captions: "" } : state), [muted, state]);

  // Once per visit, when speech works but nobody's voice is enrolled yet, say how to turn recognition on.
  const reminded = useRef(false);
  useEffect(() => {
    if (reminded.current || !state.voice.available || state.voice.enrolled) return;
    reminded.current = true;
    dispatch({ type: "alert.add", level: "info", text: "Voice recognition is not set up. Press Esc, then Enroll my voice." });
  }, [state.voice.available, state.voice.enrolled, dispatch]);

  // A touch screen has no Space or Esc: say once where the talk and menu buttons are.
  const coarse = useCoarsePointer();
  const toldTouch = useRef(false);
  useEffect(() => {
    if (!coarse || toldTouch.current || state.connection !== "open") return;
    toldTouch.current = true;
    let seen = false;
    try {
      seen = localStorage.getItem("friend.touchHint") === "1";
      localStorage.setItem("friend.touchHint", "1");
    } catch {
      /* private mode: the hint just shows each visit */
    }
    if (!seen) dispatch({ type: "alert.add", level: "info", text: "Hold the round mic button to talk, or tap it once to start and again to send. The keyboard button types; the menu button opens settings." });
  }, [coarse, state.connection, dispatch]);

  // The assistant can open the plugins screen at one integration's Configure page (to paste a token, for example).
  const openN = state.uiOpen?.n ?? 0;
  const openTarget = state.uiOpen?.integration;
  useEffect(() => {
    if (openN === 0) return;
    setPluginFocus(openTarget);
    setManagingPlugins(true);
  }, [openN, openTarget]);

  // Spotify's sign-in sends the owner back here with ?music=connected or ?music=failed: say which, and tidy the address.
  const returned = useRef(false);
  useEffect(() => {
    if (returned.current) return;
    returned.current = true;
    const n = musicReturnNotice(window.location.search);
    if (!n) return;
    dispatch({ type: "alert.add", level: n.level, text: n.text });
    window.history.replaceState(null, "", window.location.pathname);
  }, [dispatch]);

  // The earlier conversation, loaded once the connection is up, for the chat panel.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || state.connection !== "open") return;
    seeded.current = true;
    fetch("/api/history")
      .then((r) => (r.ok ? r.json() : []))
      .then((lines) => dispatch({ type: "chat.seed", lines }))
      .catch(() => {});
  }, [state.connection, dispatch]);

  // Tell the AI which panels are open so it keeps its pictures out of their way.
  useEffect(() => {
    if (state.connection !== "open") return;
    send({ type: "ui.panels", open: [...(panels.show.chat ? (["chat"] as const) : []), ...(panels.show.tasks ? (["tasks"] as const) : [])] });
  }, [state.connection, panels.show.chat, panels.show.tasks, send]);

  // Minimal hides the status line and the clock on purpose; say so once, so it never looks like a bug.
  const toldMinimal = useRef(false);
  useEffect(() => {
    if (!state.viewKnown || state.view !== "minimal" || toldMinimal.current) return;
    toldMinimal.current = true;
    dispatch({ type: "alert.add", level: "info", text: "The view is Minimal, so the status line and clock are hidden. Press Esc, then View, to bring them back." });
  }, [state.viewKnown, state.view, dispatch]);

  const setView = (view: "minimal" | "companion" | "workspace") => {
    httpSettingsApi.save({ view }).catch((e: Error) => dispatch({ type: "alert.add", level: "warn", text: e.message }));
  };

  const slash = useMemo(
    () =>
      buildSlash({
        notify: (text) => dispatch({ type: "alert.add", level: "info", text }),
        openSettings: () => setSettingsOpen("model"),
        openLook: () => setSettingsOpen("look"),
        openConnectors: () => setConnectorsOpen(true),
        openPlugins: () => setManagingPlugins(true),
        openVoice: state.voice.available ? () => setEnrolling(true) : null,
        muted,
        setMuted,
        cameraOn: state.camera.enabled,
        setCamera: (value) => dispatch({ type: "camera.enable", value }),
        clearScreen: () => {
          for (const o of state.objects) send({ type: "stage.event", objectId: o.id, event: "dismiss" });
        },
        statusLine: () =>
          describeStatus({ connection: state.connection, deviceOnline: state.deviceOnline, approval: state.approval, voiceMode: state.voice.mode, busy: state.busy, activity: state.activity }).text,
        endSession: (how) => {
          void fetch(how === "lock" ? "/api/lock" : "/api/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
            .catch(() => {})
            .finally(onSignedOut);
        },
        panelOn: (id) => panels.show[id],
        setPanel: (id, on) => panels.toggle(id, on),
        view: state.view,
        setView,
        openHelp: setHelp,
        resetLayout: () => {
          resetPositions();
          window.location.reload(); // panels read their saved place when they open
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dispatch, send, muted, onSignedOut, panels.show, panels.toggle, state.view, state.voice.available, state.voice.mode, state.camera.enabled, state.objects, state.connection, state.deviceOnline, state.approval, state.busy, state.activity],
  );

  return (
    <>
      <Stage state={shown} send={send} dispatch={dispatch} voice={voice} slash={slash} onMenu={() => setMenuRequest((n) => n + 1)} />
      <Overlay
        approval={state.approval}
        challenge={state.challenge}
        cameraStream={state.camera.stream}
        alerts={state.alerts}
        connection={state.connection}
        deviceOnline={state.deviceOnline}
        voiceMode={state.voice.mode}
        busy={state.busy}
        activity={state.activity}
        showStatus={state.viewKnown && panels.show.status}
        showClock={state.viewKnown && panels.show.clock}
        profile={state.viewKnown && panels.show.profile ? { ownerName: state.ownerName, speaker: state.speaker } : null}
        assistantName={state.assistantName}
        hud={state.hud}
        send={send}
        dispatch={dispatch}
      >
        {state.viewKnown && panels.show.chat && <ChatPanel lines={state.chat} live={state.chatLive} onSend={(text) => send({ type: "chat.send", text })} onClose={() => panels.toggle("chat", false)} />}
        {state.viewKnown && panels.show.tasks && <TasksPanel busy={state.busy} onClose={() => panels.toggle("tasks", false)} />}
        {state.viewKnown && panels.show.launcher && state.hud && <QuickLaunch items={state.hud.launcher} animations={animations} onAction={launch} />}
        {state.viewKnown && panels.show.music && <MusicPlayerView player={player} music={state.music} animations={animations} />}
        {enrolling && <EnrollmentFlow onClose={() => setEnrolling(false)} />}
        {household && <HouseholdPanel onClose={() => setHousehold(false)} />}
        {managingPlugins && (
          <PluginsPanel
            variant={menuStyle === "orb" ? "holo" : "classic"}
            {...(pluginFocus ? { initialConfigure: pluginFocus } : {})}
            onClose={() => {
              setManagingPlugins(false);
              setPluginFocus(undefined);
            }}
          />
        )}
        {settingsOpen && <SettingsPanel initialTab={settingsOpen} variant={menuStyle === "orb" ? "holo" : "classic"} onClose={() => setSettingsOpen(null)} />}
        {connectorsOpen && <ConnectorsPanel variant={menuStyle === "orb" ? "holo" : "classic"} onClose={() => setConnectorsOpen(false)} />}
        {help && <HelpPanel commands={help} onClose={() => setHelp(null)} />}
      </Overlay>
      <MenuTag
        voiceMode={state.voice.mode}
        busy={state.busy}
        onClassic={() => switchMenu("classic")}
        onOrb={() => switchMenu("orb")}
        muted={muted}
        onToggleMute={() => setMuted((m) => !m)}
        onSignedOut={onSignedOut}
        voiceAvailable={state.voice.available}
        voiceEnrolled={state.voice.enrolled}
        onEnroll={() => setEnrolling(true)}
        onHousehold={() => setHousehold(true)}
        handsFreeOn={handsFree.on}
        onToggleHandsFree={handsFree.supported ? handsFree.toggle : undefined}
        assistantName={state.assistantName}
        onPlugins={() => setManagingPlugins(true)}
        onSettings={(tab) => setSettingsOpen(tab ?? "model")}
        onConnectors={() => setConnectorsOpen(true)}
        cameraOn={state.camera.enabled}
        onToggleCamera={() => dispatch({ type: "camera.enable", value: !state.camera.enabled })}
        chatOn={panels.show.chat}
        onToggleChat={() => panels.toggle("chat")}
        tasksOn={panels.show.tasks}
        onToggleTasks={() => panels.toggle("tasks")}
        musicOn={panels.show.music}
        onToggleMusic={() => panels.toggle("music")}
        launcherOn={panels.show.launcher}
        onToggleLauncher={() => panels.toggle("launcher")}
        view={state.view}
        onView={setView}
        openRequest={menuRequest}
      />
      {state.connection === "elsewhere" && <ElsewhereCard onUseHere={useHere} />}
    </>
  );
}

export function App() {
  const [phase, setPhase] = useState<Phase>("loading");

  // Nothing of the home screen is drawn until the server says this browser is signed in. If the server cannot be asked, the sign-in screen is shown, never the home screen.
  useEffect(() => {
    let live = true;
    const go = (p: Phase) => live && setPhase(p);
    (async () => {
      try {
        const state = (await (await fetch("/api/state")).json()) as { hasOwner: boolean };
        if (!state.hasOwner) return go("setup");
        const session = (await (await fetch("/api/session", { cache: "no-store" })).json()) as { signedIn?: boolean };
        go(session.signedIn === true ? "stage" : "login");
      } catch {
        go("login");
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (phase === "loading") return <div className="boot" aria-busy="true" />;
  if (phase === "setup") return <SetupScreen onDone={() => setPhase("login")} />;
  if (phase === "login") return <LoginScreen onLoggedIn={() => setPhase("stage")} />;
  return <StageApp onSignedOut={() => setPhase("login")} />;
}
