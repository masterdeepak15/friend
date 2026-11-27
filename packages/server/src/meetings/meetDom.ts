import { HELPERS, SEND_CHAT, clickLabel, type DomSet } from "./domKit";

/**
 * What the Google Meet page looks like to a program (guest join: no Google account). Meet changes its page now and then, so everything
 * that depends on it is here, each thing with more than one way to find it. Not yet checked against a live Meet call.
 */
const ENDED = String.raw`/you left the meeting|you['’]ve left the meeting|the meeting has ended|you['’]ve been removed from the meeting|you were removed from the meeting|return to home screen|call ended/i`;
const LOBBY = String.raw`/asking to be let in|someone will let you in soon|waiting for (someone|the host)[^.]{0,30}(let|admit)|you['’]ll join when someone lets you in/i`;

const advance = (name: string, anyHost: boolean): string => `(() => { ${HELPERS}
  const NAME = ${JSON.stringify(name)};
  const body = (document.body && document.body.innerText) || "";
  const here = location.hostname;
  if (!${anyHost} && here && !/(^|\\.)(google\\.com)$/i.test(here)) return { phase: "unknown", detail: "The page went somewhere that is not Google Meet (" + here + ") and was left alone." };
  if (${ENDED}.test(body)) return { phase: "ended", detail: "" };
  if (${LOBBY}.test(body)) return { phase: "lobby", detail: "" };
  const leave = byText(/^\\s*leave call\\b/i, "button, [role=button]") || document.querySelector('button[aria-label*="Leave call" i]');
  if (leave && vis(leave)) return { phase: "in", detail: "" };
  const nameBox = all('input[aria-label*="your name" i], input[placeholder*="your name" i], input[aria-label="Name"]')[0];
  const join = byText(/^\\s*(ask to join|join now|join)\\s*$/i, "button, [role=button]");
  if (nameBox || join) {
    if (nameBox && nameBox.value !== NAME) setValue(nameBox, NAME);
    // a guest arrives with the camera and the microphone off
    for (const t of all('[role=button][aria-label*="Turn off microphone" i]')) t.click();
    if (join && (!nameBox || nameBox.value === NAME)) { join.click(); return { phase: "prejoin", detail: "Pressed " + txt(join) + "." }; }
    return { phase: "prejoin", detail: "Filling in the guest name." };
  }
  const without = byText(/continue without (microphone|camera|mic)|dismiss|got it/i);
  if (without) { without.click(); return { phase: "loading", detail: "Closed a notice." }; }
  return { phase: "loading", detail: body.slice(0, 140).replace(/\\s+/g, " ") };
})()`;

const captions = `(() => { ${HELPERS}
  const region = document.querySelector('[role="region"][aria-label*="aptions" i], [aria-label="Captions"]');
  if (!region) return { on: false, items: [] };
  const items = [];
  for (const block of Array.from(region.children)) {
    const kids = Array.from(block.querySelectorAll("div, span")).filter((e) => e.children.length === 0 && txt(e));
    if (kids.length < 2) continue;
    items.push({ speaker: txt(kids[0]), text: kids.slice(1).map(txt).join(" ") });
  }
  return { on: true, items };
})()`;

const focusChat = `(() => { ${HELPERS}
  const box = () => all('textarea[aria-label*="send a message" i], textarea[placeholder*="send a message" i]')[0];
  let b = box();
  if (!b) { const open = byText(/chat with everyone/i, "button, [role=button]"); if (open) open.click(); }
  return new Promise((done) => setTimeout(() => { b = box(); if (!b) return done(false); b.focus(); done(true); }, 700));
})()`;

export const MEET: DomSet = {
  advance,
  captions,
  captionSteps: [clickLabel(String.raw`/turn on captions/i`), clickLabel(String.raw`/^\s*(got it|ok)\s*$/i`)],
  shortcut: { key: "c", code: "KeyC", vk: 67, modifiers: 0 },
  focusChat,
  sendChat: SEND_CHAT('textarea[aria-label*="send a message" i], textarea[placeholder*="send a message" i]', 'button[aria-label*="send a message" i], button[aria-label^="Send" i]'),
  hangUp: clickLabel(String.raw`/^\s*leave call\b/i`),
};
