/**
 * What the Teams web page looks like to a program. Teams changes its page now and then, so everything that depends on it is in this
 * one file: the words and attributes it looks for, with more than one way to find each thing. Each is a piece of script that runs
 * inside the page and returns plain data.
 */

import { HELPERS, SEND_CHAT, type DomSet } from "./domKit";

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
// the more menu opens only for a real mouse click, so this gives back where to click
// (some versions of the page open it for a plain click and ignore a mouse press, others the other way round: the plain click is tried first, and if no menu came up the centre of the button is given back for a real mouse press)
// (the more menu closes by itself within a second on today's page, so opening it and pressing Captions is one step)
export const CAPTION_QUICK = `(async () => { ${HELPERS}
  const item = () => { const i = document.getElementById("closed-captions-button"); return i && vis(i) ? i : null; };
  let i = item();
  if (!i) {
    const b = document.querySelector('[data-tid="more-button"], #callingButtons-showMoreBtn, [id*="showMoreBtn"]');
    if (!b) return false;
    b.click();
    for (let k = 0; k < 8 && !(i = item()); k++) await new Promise((r) => setTimeout(r, 150));
  }
  if (!i) return false;
  if (i.getAttribute("aria-checked") !== "true") i.click();
  return true;
})()`;
export const OPEN_MORE = `(async () => { ${HELPERS} const menuUp = () => vis(document.getElementById("closed-captions-button")) || !!byText(/language and speech|^\\s*captions\\b/i, "[role=menuitem], [role=menuitemcheckbox]"); if (menuUp()) return true; const b = document.querySelector('[data-tid="more-button"], #callingButtons-showMoreBtn, [id*="showMoreBtn"]') || byText(/^\\s*more( actions)?\\b/i, "button, [role=button]"); if (!b) return false; b.click(); await new Promise((r) => setTimeout(r, 700)); if (menuUp()) return true; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
// in the menu the item is called "Captions" (and is checked when they are on: it is then left alone); older versions have "Language and speech"
export const CLICK_CAPTIONS_ITEM = `(() => { ${HELPERS} const b = document.getElementById("closed-captions-button") || byText(/^\\s*captions\\b/i, "[role=menuitem], [role=menuitemcheckbox]"); if (!b) return false; if (b.getAttribute("aria-checked") !== "true") b.click(); return true; })()`;
export const CLICK_LANGUAGE = `(() => { ${HELPERS} const b = byText(/language and speech/i); if (!b) return false; b.click(); return true; })()`;
export const CLICK_CAPTIONS = `(() => { ${HELPERS} const b = byText(/turn on live captions|show live captions|live captions/i); if (!b) return false; b.click(); return true; })()`;
export const CLICK_CONFIRM = `(() => { ${HELPERS} const b = byText(/^\\s*confirm\\s*$/i, "button, [role=button]"); if (!b) return false; b.click(); return true; })()`;

/** The chat: opens it if it is closed and puts the cursor in the message box. */
export const FOCUS_CHAT = `(() => { ${HELPERS}
  const box = () => all('[data-tid="ckeditor"], div[role="textbox"][contenteditable="true"], [data-tid="chat-message-input"] [contenteditable="true"]')[0];
  let b = box();
  if (!b) { const open = document.querySelector('[data-tid="chat-button"], #chat-button') || byText(/^\\s*chat\\b/i, "button, [role=button]"); if (open) open.click(); }
  return new Promise((done) => setTimeout(() => { b = box(); if (!b) return done(false); b.focus(); done(true); }, 1200));
})()`;

export const HANG_UP = `(() => { ${HELPERS} const b = document.querySelector('[data-tid="hangup-button"], #hangup-button') || byText(/^\\s*(leave|hang up)\\b/i, "button, [role=button]"); if (!b) return false; b.click(); return true; })()`;

/** The messages in the meeting chat, oldest first. Opens the chat when no list is on screen (and says null that time). */
export const READ_CHAT = `(() => { ${HELPERS}
  const ITEM = '[data-tid="chat-pane-item"], [data-tid="chat-pane-message"], [data-tid="message-pane-body"] [role="listitem"], [data-tid="chat-message-list"] [role="listitem"], [data-tid="message-pane-list-viewport"] [role="listitem"], [data-tid="message-pane-list-viewport"] [role="group"]';
  const pane = document.querySelector('[data-tid="message-pane-list-viewport"], [data-tid="chat-pane"], [data-tid="meeting-chat-pane"], [data-tid="chat-message-list"]');
  if (!pane) { const open = document.querySelector('[data-tid="chat-button"], #chat-button') || byText(/^\\s*chat\\b/i, "button, [role=button]"); if (open) open.click(); return null; }
  const seen = new Set();
  const out = [];
  let prev = "";
  for (const el of Array.from(document.querySelectorAll(ITEM))) {
    if (seen.has(el) || Array.from(seen).some((s) => s.contains(el))) continue;
    seen.add(el);
    const a = el.querySelector('[data-tid="message-author-name"], [data-tid*="author"]');
    const b = el.querySelector('[data-tid="chat-pane-message"], [data-tid="message-body-content"], [id^="content-"], [data-tid="message-body"]');
    let sender = a ? txt(a) : "";
    if (sender) prev = sender; else sender = prev;
    let text = b ? txt(b) : txt(el);
    if (!b && a) text = text.replace(txt(a), "").trim();
    if (text && sender) out.push({ sender, text: text.slice(0, 600) });
  }
  return out;
})()`;

/** The people on the stage: their names, and who has the speaking ring now (what the page marks varies, so several marks are tried). */
export const PEOPLE = `(() => { ${HELPERS}
  const TILE = '[data-tid*="video-tile"], [data-tid*="participant-tile"], [data-tid="calling-participant-stream"], [data-tid*="stream-container"], [data-cid*="tile"], [role="listitem"][aria-label]';
  const names = [];
  const speaking = [];
  // Teams today: a tile is an element with data-stream-type whose data-tid is the person's name; its ring changes its class while they speak
  // (the class names are hashes that change with every Teams build, so the idle look is learned: the one seen most often)
  const R = (window.__friendRing = window.__friendRing || {});
  for (const t of Array.from(document.querySelectorAll("[data-stream-type]"))) {
    const name = (t.getAttribute("data-tid") || "").replace(/\\s*\\((guest|external|unverified)[^)]*\\)/i, "").trim();
    if (!name || name.length > 60) continue;
    if (!names.includes(name)) names.push(name);
    const o = t.querySelector('[data-tid="voice-level-stream-outline"]');
    if (!o) continue;
    const sig = String(o.className);
    const r = (R[name] = R[name] || {});
    r[sig] = (r[sig] || 0) + 1;
    const sigs = Object.keys(r).sort((a, b) => r[b] - r[a]);
    if (sigs.length > 1 && sig !== sigs[0]) speaking.push(name);
  }
  if (!names.length) for (const el of all(TILE)) {
    const n = el.querySelector('[data-tid*="display-name"], [data-tid*="participant-name"], [data-tid*="name"]');
    let name = n ? txt(n) : (el.getAttribute("aria-label") || "").split(",")[0].trim();
    name = name.replace(/\\s*\\((guest|external|unverified)[^)]*\\)/i, "").trim();
    if (!name || name.length > 60) continue;
    if (!names.includes(name)) names.push(name);
    const ring = el.querySelector('[data-tid*="voice-level"], [data-tid*="speaking"], [class*="speaking" i], [class*="voice-level" i]');
    if (ring || /speaking/i.test(el.getAttribute("aria-label") || "")) speaking.push(name);
  }
  return { names, speaking };
})()`;

// sharing: the share button, then the choice of what to share (our own page answers the browser's question with its stage)
// (a plain click is what Teams answers: a real mouse press on its buttons does nothing on this page; when it is sharing already the button says so and is left alone)
export const CLICK_SHARE = `(() => { ${HELPERS} const b = document.querySelector('#screenshare-button, [data-tid="screenshare-button"], [data-tid="share-button"], #share-button') || byText(/^\\s*(share|present)\\b/i, "button, [role=button]"); if (!b || !vis(b)) return false; if (!/stop (sharing|presenting)/i.test(label(b))) b.click(); return true; })()`;
export const CLICK_SCREEN = `(() => { ${HELPERS} const b = byText(/^\\s*(screen|entire screen|share (the )?screen|present (the )?screen)\\b/i, "button, [role=button], [role=menuitem], [role=option], [data-tid*="screen"]") || document.querySelector('[data-tid*="share-screen"], [data-tid*="screen-share"]'); if (!b) return false; b.click(); return true; })()`;
export const STOP_SHARE = `(() => { ${HELPERS} const b = document.querySelector('[data-tid="stop-sharing-button"], [data-tid="unshare-button"]') || byText(/stop (presenting|sharing)/i, "button, [role=button]"); if (!b) return false; b.click(); return true; })()`;

export const TEAMS: DomSet = {
  readChat: READ_CHAT,
  people: PEOPLE,
  shareSteps: [CLICK_SHARE, CLICK_SCREEN],
  stopShare: STOP_SHARE,
  advance: ADVANCE,
  captions: CAPTIONS,
  captionQuick: CAPTION_QUICK,
  captionSteps: [OPEN_MORE, CLICK_CAPTIONS_ITEM, CLICK_LANGUAGE, CLICK_CAPTIONS, CLICK_CONFIRM],
  // Ctrl+Shift+U switches live captions on or off in Teams
  shortcut: { key: "U", code: "KeyU", vk: 85, modifiers: 10 },
  focusChat: FOCUS_CHAT,
  sendChat: SEND_CHAT('[data-tid="ckeditor"], div[role="textbox"][contenteditable="true"]', '[data-tid="newMessageCommands-send"], button[aria-label^="Send" i]'),
  hangUp: HANG_UP,
};