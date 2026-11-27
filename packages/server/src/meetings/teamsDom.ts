/**
 * What the Teams web page looks like to a program. Teams changes its page now and then, so everything that depends on it is in this
 * one file: the words and attributes it looks for, with more than one way to find each thing. Each is a piece of script that runs
 * inside the page and returns plain data.
 */

import { HELPERS, type DomSet } from "./domKit";

const ENDED = String.raw`/(you['’]ve left|you left|you have left) the (meeting|call)|the (meeting|call) (has )?ended|this meeting has ended|(you were|you['’]ve been|you have been) removed from the (meeting|call)|removed you from the (meeting|call)/i`;
const LOBBY = String.raw`/waiting for (someone|the organi[sz]er|the host)[^.]{0,40}(let|admit)|someone in the meeting (will|should) let you in|we['’]ll let (people|them) know you['’]re (here|waiting)|let you in (soon|shortly)|someone will let you in/i`;

/** Looks at the screen, does the next thing that gets it into the meeting, and says which screen it is. */
export const ADVANCE = (name: string, anyHost = false): string => `(() => { ${HELPERS}
  const NAME = ${JSON.stringify(name)};
  const body = (document.body && document.body.innerText) || "";
  const here = location.hostname;
  const ok = ${anyHost} || /(^|\\.)(microsoft\\.com|live\\.com|office\\.com|skype\\.com|microsoftonline\\.com|cloud\\.microsoft)$/i.test(here);
  if (!ok && here) return { phase: "unknown", detail: "The page went somewhere that is not Teams (" + here + ") and was left alone." };
  if (${ENDED}.test(body)) return { phase: "ended", detail: "" };
  if (${LOBBY}.test(body)) return { phase: "lobby", detail: "" };
  const hang = document.querySelector('[data-tid="hangup-button"], #hangup-button, button[id*="hangup" i]') || byText(/^\\s*(leave|hang up)\\b/i, "button, [role=button]");
  const callBar = document.querySelector('[data-tid="calling-bar"], [data-tid="call-controls"], #calling-bar, [data-tid="meeting-control-bar"]');
  if (hang && vis(hang) && !document.querySelector('[data-tid="prejoin-join-button"]')) return { phase: "in", detail: "" };
  if (callBar && !document.querySelector('[data-tid="prejoin-join-button"]')) return { phase: "in", detail: "" };
  // the name and the join button
  const nameBox = all('input[data-tid="prejoin-display-name-input"], input[name="displayName"], input[placeholder*="name" i], input[aria-label*="name" i]')[0];
  const join = document.querySelector('[data-tid="prejoin-join-button"]') || byText(/^\\s*join now\\s*$/i, "button, [role=button]");
  if (nameBox || join) {
    if (nameBox && nameBox.value !== NAME) setValue(nameBox, NAME);
    // a guest arrives with the camera and the microphone off
    for (const t of all('[data-tid="toggle-video"], [data-tid="toggle-mute"], [role=switch], [role=checkbox], [role=button][aria-pressed]')) {
      if (!/camera|video|microphone|mic\\b|mute/i.test(label(t))) continue;
      if (t.getAttribute("aria-checked") === "true" || t.getAttribute("aria-pressed") === "true") { if (/camera|video/i.test(label(t)) || t.getAttribute("data-tid") === "toggle-video") t.click(); }
    }
    if (join && !join.disabled && (!nameBox || nameBox.value === NAME)) { join.click(); return { phase: "prejoin", detail: "Pressed Join now." }; }
    return { phase: "prejoin", detail: "Filling in the guest name." };
  }
  // the page that offers the app first
  const web = byText(/continue on this browser|use the web app instead|join on the web instead|open in the browser|watch on the web/i) || byText(/join (as a )?guest|continue without (signing in|an account)|join anonymously/i);
  if (web) { web.click(); return { phase: "loading", detail: "Chose the web version." }; }
  return { phase: "loading", detail: body.slice(0, 140).replace(/\\s+/g, " ") };
})()`;

/** The caption panel: who said what, as it is on screen now. null items = the panel is not there (captions are off). */
export const CAPTIONS = `(() => { ${HELPERS}
  const texts = Array.from(document.querySelectorAll('[data-tid="closed-caption-text"], [data-tid="closed-caption-message-text"]'));
  const panel = document.querySelector('[data-tid="closed-caption-renderer-wrapper"], [data-tid="closed-captions-renderer"], [data-tid="closed-caption-v2-virtual-list-content"], [data-tid="closed-caption-v2-window-wrapper"]');
  if (!texts.length && !panel) return { on: false, items: [] };
  let prev = "";
  const items = texts.map((t) => {
    let speaker = "";
    let n = t;
    for (let i = 0; i < 6 && n && !speaker; i++) {
      n = n.parentElement;
      const a = n && n.querySelector('[data-tid="author"], [data-tid="closed-caption-author"]');
      if (a) speaker = txt(a);
    }
    if (!speaker) speaker = prev; else prev = speaker;
    return { speaker, text: txt(t) };
  });
  return { on: true, items };
})()`;

/** Opens the "more" menu. */
export const OPEN_MORE = `(() => { ${HELPERS} const b = document.querySelector('[data-tid="more-button"], #callingButtons-showMoreBtn, [id*="showMoreBtn"]') || byText(/^\\s*more( actions)?\\b/i, "button, [role=button]"); if (!b) return false; b.click(); return true; })()`;
export const CLICK_LANGUAGE = `(() => { ${HELPERS} const b = byText(/language and speech/i); if (!b) return false; b.click(); return true; })()`;
export const CLICK_CAPTIONS = `(() => { ${HELPERS} const b = byText(/turn on live captions|show live captions|live captions/i); if (!b) return false; b.click(); return true; })()`;
export const CLICK_CONFIRM = `(() => { ${HELPERS} const b = byText(/^\\s*confirm\\s*$/i, "button, [role=button]"); if (!b) return false; b.click(); return true; })()`;

/** The chat: opens it if it is closed and puts the cursor in the message box. */
export const FOCUS_CHAT = `(() => { ${HELPERS}
  const box = () => all('[data-tid="ckeditor"], div[role="textbox"][contenteditable="true"], [data-tid="chat-message-input"] [contenteditable="true"]')[0];
  let b = box();
  if (!b) { const open = document.querySelector('[data-tid="chat-button"], #chat-button') || byText(/^\\s*chat\\b/i, "button, [role=button]"); if (open) open.click(); }
  return new Promise((done) => setTimeout(() => { b = box(); if (!b) return done(false); b.focus(); done(true); }, 700));
})()`;

export const HANG_UP = `(() => { ${HELPERS} const b = document.querySelector('[data-tid="hangup-button"], #hangup-button') || byText(/^\\s*(leave|hang up)\\b/i, "button, [role=button]"); if (!b) return false; b.click(); return true; })()`;

export const TEAMS: DomSet = {
  advance: ADVANCE,
  captions: CAPTIONS,
  captionSteps: [OPEN_MORE, CLICK_LANGUAGE, CLICK_CAPTIONS, CLICK_CONFIRM],
  // Ctrl+Shift+U switches live captions on or off in Teams
  shortcut: { key: "U", code: "KeyU", vk: 85, modifiers: 10 },
  focusChat: FOCUS_CHAT,
  hangUp: HANG_UP,
};