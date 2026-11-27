import { HELPERS, SEND_CHAT, clickLabel, type DomSet } from "./domKit";

/**
 * What the Zoom web client looks like to a program (join from the browser as a guest, no account). Zoom changes its page now and then,
 * so everything that depends on it is here, each thing with more than one way to find it. Not yet checked against a live Zoom call.
 */
const ENDED = String.raw`/this meeting has been ended|the meeting has ended|you have left the meeting|you were removed from the meeting|host has ended this meeting|meeting is over/i`;
const LOBBY = String.raw`/please wait,? the meeting host will let you in soon|waiting room|the host will let you in|host will admit you/i`;

const advance = (name: string, anyHost: boolean): string => `(() => { ${HELPERS}
  const NAME = ${JSON.stringify(name)};
  const body = (document.body && document.body.innerText) || "";
  const here = location.hostname;
  if (!${anyHost} && here && !/(^|\\.)(zoom\\.us|zoom\\.com|zoomgov\\.com)$/i.test(here)) return { phase: "unknown", detail: "The page went somewhere that is not Zoom (" + here + ") and was left alone." };
  if (${ENDED}.test(body)) return { phase: "ended", detail: "" };
  if (${LOBBY}.test(body)) return { phase: "lobby", detail: "" };
  const leave = document.querySelector('button.footer__leave-btn, [aria-label="Leave"], button[aria-label*="Leave" i]');
  const footer = document.querySelector("#foot-bar, .footer, [class*='footer__']");
  if ((leave && vis(leave)) || (footer && vis(footer) && document.querySelector('[aria-label*="participants" i]'))) return { phase: "in", detail: "" };
  const nameBox = all('#input-for-name, input[name="name"], input[placeholder*="your name" i], input[aria-label*="your name" i]')[0];
  const join = document.querySelector("button.preview-join-button") || byText(/^\\s*join\\s*$/i, "button, [role=button]");
  if (nameBox || join) {
    if (nameBox && nameBox.value !== NAME) setValue(nameBox, NAME);
    const pass = all('#input-for-pwd, input[type="password"]')[0];
    if (pass && !pass.value) return { phase: "prejoin", detail: "The meeting asks for a passcode that is not in the link." };
    if (join && !join.disabled && (!nameBox || nameBox.value === NAME)) { join.click(); return { phase: "prejoin", detail: "Pressed Join." }; }
    return { phase: "prejoin", detail: "Filling in the guest name." };
  }
  // the page that offers the app first, and the notices on the way
  const web = byText(/join from your browser|launch meeting|use the web client|continue in browser/i) || document.querySelector("#joinBtn");
  if (web) { web.click(); return { phase: "loading", detail: "Chose the browser version." }; }
  const ok = byText(/^\\s*(accept cookies|accept|i agree|got it|ok|continue)\\s*$/i, "button, [role=button]");
  if (ok) { ok.click(); return { phase: "loading", detail: "Closed a notice." }; }
  return { phase: "loading", detail: body.slice(0, 140).replace(/\\s+/g, " ") };
})()`;

const captions = `(() => { ${HELPERS}
  const box = document.querySelector('#live-transcription-subtitle, .live-transcription-subtitle__box, [class*="subtitle"][class*="box"]');
  if (!box) return { on: false, items: [] };
  const t = txt(box);
  if (!t) return { on: true, items: [] };
  const who = box.querySelector('[class*="name"], [class*="speaker"]');
  return { on: true, items: [{ speaker: who ? txt(who) : "", text: who ? t.replace(txt(who), "").trim() : t }] };
})()`;

const focusChat = `(() => { ${HELPERS}
  const box = () => all('.chat-box__chat-textarea, #chat-textarea, textarea[aria-label*="message" i], [contenteditable="true"][aria-label*="message" i]')[0];
  let b = box();
  if (!b) { const open = byText(/^\\s*chat\\b/i, "button, [role=button]") || document.querySelector('button[aria-label*="chat" i]'); if (open) open.click(); }
  return new Promise((done) => setTimeout(() => { b = box(); if (!b) return done(false); b.focus(); done(true); }, 700));
})()`;

export const ZOOM: DomSet = {
  advance,
  captions,
  captionSteps: [clickLabel(String.raw`/^\s*(more|more meeting controls)\b/i`), clickLabel(String.raw`/captions|subtitle|transcript/i`), clickLabel(String.raw`/show subtitle|show captions|enable captions/i`)],
  focusChat,
  sendChat: SEND_CHAT('.chat-box__chat-textarea, #chat-textarea, textarea[aria-label*="message" i], [contenteditable="true"][aria-label*="message" i]', 'button[aria-label^="Send" i], .chat-box__send-button'),
  hangUp: `(() => { ${HELPERS} const b = document.querySelector('button.footer__leave-btn, button[aria-label*="Leave" i]'); if (!b) return false; b.click(); const c = byText(/^\\s*(leave meeting|leave)\\s*$/i); if (c) c.click(); return true; })()`,
};
