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
  hangUp: string;
}

/** A script that clicks the first visible button whose label matches the pattern. */
export const clickLabel = (re: string, sel?: string): string => `(() => { ${HELPERS} const b = byText(${re}${sel ? `, ${JSON.stringify(sel)}` : ""}); if (!b) return false; b.click(); return true; })()`;
