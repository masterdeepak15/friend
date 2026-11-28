/** What every meeting site's page driver shares: small helpers that run inside the page, and the shape of a site's set of scripts. */

export const HELPERS = `
const txt = (e) => ((e && (e.innerText || e.textContent)) || "").replace(/\\s+/g, " ").trim();
const vis = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
const all = (sel) => Array.from(document.querySelectorAll(sel)).filter(vis);
const label = (e) => (e.getAttribute("aria-label") || "") + " " + txt(e);
const CLICKABLE = "button, [role=button], a, [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option]";
const byText = (re, sel) => all(sel || CLICKABLE).find((e) => re.test(label(e)));
const setValue = (el, v) => {
  const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
  d.set.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
`;

export interface DomSet {
  /** Looks at the screen, does the next thing that gets it into the meeting, and says which screen it is. */
  advance(name: string, anyHost: boolean): string;
  /** The caption panel as { on, items: [{ speaker, text }] }. */
  captions: string;
  /** Scripts that turn the captions on, one after the other; each returns true when it found what to click. */
  captionSteps: string[];
  /** A keyboard shortcut that toggles captions, tried on alternate attempts. */
  shortcut?: { key: string; code: string; vk: number; modifiers: number };
  /** Opens the chat if it is closed and puts the cursor in the message box; true when it could. */
  focusChat: string;
  /** After a message was typed: true when the box is empty (it was sent), or the centre of the send button to press with the mouse. */
  sendChat: string;
  hangUp: string;
  /** The chat as [{ sender, text }] (null when no chat list is on screen: it is then opened for the next look). */
  readChat?: string;
  /** The people on the screen as { names, speaking }. */
  people?: string;
  /** Scripts that start sharing the screen, one after the other; each returns true or the centre of a button to press with the mouse. */
  shareSteps?: string[];
  /** Stops sharing. */
  stopShare?: string;
}

/** A script that clicks the first visible button whose label matches the pattern. */
export const clickLabel = (re: string, sel?: string): string => `(() => { ${HELPERS} const b = byText(${re}${sel ? `, ${JSON.stringify(sel)}` : ""}); if (!b) return false; b.click(); return true; })()`;

/**
 * Puts the meeting's microphone button in the state wanted (true = sound goes out). Every site labels it the same two ways: "Mute"/"Turn off
 * microphone" while it is live and "Unmute"/"Turn on microphone" while it is muted. Returns true when the microphone is now as wanted.
 */
export const micTo = (on: boolean): string => `(() => { ${HELPERS}
  const MUTED = /unmute|turn on (your |my )?(mic|microphone)|microphone is (off|muted)/i;
  const LIVE = /(^|\\s)mute\\b|turn off (your |my )?(mic|microphone)|microphone is on/i;
  const btn = all('button, [role=button], [role=switch]').find((e) => /mic|mute/i.test(label(e)) && (MUTED.test(label(e)) || LIVE.test(label(e))) && !/camera|video|speaker|audio output/i.test(label(e)));
  if (!btn) return false;
  const l = label(btn);
  const muted = btn.getAttribute("data-is-muted") === "true" || MUTED.test(l);
  if (muted === ${!on}) return true;
  btn.click();
  return true;
})()`;

/** Puts the meeting camera button in the state wanted (true = the picture goes out). */
export const camTo = (on: boolean): string => `(() => { ${HELPERS}
  const OFF = /turn camera on|turn on (your |my )?camera|start (my )?video|camera is off/i;
  const ON = /turn camera off|turn off (your |my )?camera|stop (my )?video|camera is on/i;
  const btn = all('button, [role=button], [role=switch]').find((e) => (OFF.test(label(e)) || ON.test(label(e))) && !/effects|background|settings|devices/i.test(label(e)));
  if (!btn) return false;
  if (OFF.test(label(btn)) === ${on}) btn.click();
  return true;
})()`;

/** What a chat box looks like to a program, the same on every site: empty once the message went. */
export const SEND_CHAT = (boxSel: string, sendSel: string): string => `(() => { ${HELPERS}
  const box = all(${JSON.stringify(boxSel)})[0];
  if (!box || !((box.value !== undefined ? box.value : txt(box)) || "").trim()) return true;
  const send = all(${JSON.stringify(sendSel)})[0] || byText(/^\\s*send\\b/i, "button, [role=button]");
  if (!send) return false;
  const b = send.getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
})()`;
