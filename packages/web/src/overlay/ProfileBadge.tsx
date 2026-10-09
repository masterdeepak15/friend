import { useEffect, useState } from "react";
import { Movable } from "../layout/Movable";
import type { StageViewState } from "../store";

/** How long the badge keeps showing who spoke last before it goes back to showing the owner. */
export const SPEAKER_MS = 20_000;

const Shield = ({ letter, tone }: { letter: string; tone: "owner" | "member" | "guest" }) => (
  <svg className={`profile-shield ${tone}`} width="34" height="38" viewBox="0 0 34 38" aria-hidden="true">
    <path d="M17 2 31 7v11c0 8.5-5.6 15.6-14 18C8.6 33.6 3 26.5 3 18V7z" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <text x="17" y="24" textAnchor="middle" fontSize="14" fontWeight="600" fill="currentColor">
      {letter}
    </text>
  </svg>
);

/**
 * A shield with the initial of the person Friend is talking to, and their name: the owner who is signed in, or the family
 * member whose voice was just recognized, or a guest. It lives in the client-owned overlay, so the AI cannot hide or fake it.
 */
export function ProfileBadge({ ownerName, speaker }: { ownerName: string; speaker: StageViewState["speaker"] }) {
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

  return (
    <Movable id="profile" label="Profile" wholeBox testId="profile" className="profile-badge">
      <Shield letter={letter} tone={who.tone} />
      <span className="profile-text">
        <b>{who.name}</b>
        <small>{who.note}</small>
      </span>
    </Movable>
  );
}
