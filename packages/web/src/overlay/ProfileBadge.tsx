import { useEffect, useState } from "react";
import { Movable } from "../layout/Movable";
import type { StageViewState } from "../store";

/** How long the badge keeps showing who spoke last before it goes back to showing the owner. */
export const SPEAKER_MS = 20_000;

/** The round emblem: a slowly turning ring, a ring that chases round while Friend works, and the shield with the person's initial. */
const Emblem = ({ letter, tone }: { letter: string; tone: "owner" | "member" | "guest" }) => (
  <svg className={`profile-shield hud-emblem-svg ${tone}`} width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
    <circle className="hud-ring-turn" cx="32" cy="32" r="30" fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.4" strokeDasharray="2 5" />
    <circle className="hud-ring-chase" cx="32" cy="32" r="26.500" fill="none" stroke="currentColor" strokeWidth="2.200" strokeLinecap="round" strokeDasharray="14 150" />
    <circle cx="32" cy="32" r="22" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1" />
    <path d="M32 15 44 19.500v9c0 7.200-4.800 13.300-12 15.500-7.200-2.200-12-8.300-12-15.500v-9z" fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.500" strokeLinejoin="round" />
    <text x="32" y="36" textAnchor="middle" fontSize="13" fontWeight="600" fill="currentColor">
      {letter}
    </text>
  </svg>
);

/**
 * The profile widget: a round emblem with the initial of the person Friend is talking to, and an angled name tag: the assistant's
 * terminal name, the person's name and whether they are the owner who is signed in, a recognized family member, or a guest. It lives
 * in the client-owned overlay, so the AI cannot hide or fake it.
 */
export function ProfileBadge({
  ownerName,
  speaker,
  assistantName = "",
  terminalLabel = "TERMINAL",
  busy = false,
  listening = false,
}: {
  ownerName: string;
  speaker: StageViewState["speaker"];
  assistantName?: string;
  terminalLabel?: string;
  busy?: boolean;
  listening?: boolean;
}) {
  const [recent, setRecent] = useState(false);
  useEffect(() => {
    if (!speaker) return;
    setRecent(true);
    const t = setTimeout(() => setRecent(false), SPEAKER_MS);
    return () => clearTimeout(t);
  }, [speaker?.seq]);

  const owner = ownerName.trim() || "Owner";
  const who = recent && speaker && speaker.trust === "member" && speaker.name ? { name: speaker.name, note: "family", tone: "member" as const } : recent && speaker?.trust === "guest" ? { name: "Guest", note: "voice not recognized", tone: "guest" as const } : { name: owner, note: "signed in", tone: "owner" as const };
  const letter = (who.tone === "guest" ? "?" : who.name.trim().charAt(0) || "?").toUpperCase();
  const top = [assistantName.trim(), terminalLabel.trim()].filter(Boolean).join(" ");

  return (
    <Movable id="profile" label="Profile" wholeBox testId="profile" className={`hud hud-profile ${who.tone}${recent ? " speaking" : ""}${busy ? " busy" : ""}${listening ? " listening" : ""}`}>
      <span key={speaker?.seq ?? 0} className="hud-emblem">
        <Emblem letter={letter} tone={who.tone} />
      </span>
      <span className="hud-tag hud-cut">
        {top && <small className="hud-tag-top">{top}</small>}
        <b>{who.name}</b>
        <small>{who.note}</small>
      </span>
    </Movable>
  );
}
