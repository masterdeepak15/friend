import type { Deck, DeckItem } from "@friend/protocol";

const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const label = (c: unknown, i: number): { key: string; label: string } =>
  c && typeof c === "object"
    ? { key: String((c as { key?: unknown }).key ?? `c${i}`), label: String((c as { label?: unknown }).label ?? (c as { key?: unknown }).key ?? "") }
    : { key: `c${i}`, label: String(c) };

function table(columns: unknown[], rows: unknown[]): string {
  const cols = columns.map(label);
  const body = rows.map((r) => `<tr>${cols.map((c, i) => `<td>${esc(Array.isArray(r) ? r[i] : (r as Record<string, unknown>)?.[c.key])}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
}

/** What an item looks like in a page that stands alone: text as text, data as a plain table or list, nothing that needs Friend. */
function body(item: DeckItem): string {
  const c = item.content;
  const title = typeof c.title === "string" ? `<h4>${esc(c.title)}</h4>` : "";
  switch (item.kind) {
    case "text": {
      const t = esc(c.text);
      return c.style === "heading" ? `<h3>${t}</h3>` : c.style === "quote" ? `<blockquote>${t}</blockquote>` : `<p class="bullet">${t}</p>`;
    }
    case "table":
    case "JTable":
      return `${title}${table(arr(c.columns), arr(c.rows))}`;
    case "list":
    case "checklist":
      return `${title}<ul>${arr(c.items).map((i) => `<li>${esc(typeof i === "object" && i ? ((i as { text?: unknown }).text ?? (i as { label?: unknown }).label ?? "") : i)}</li>`).join("")}</ul>`;
    case "card":
    case "JCard":
      return `${title}<p>${esc(c.text)}</p>`;
    case "stat":
    case "JStatCard":
      return `<p class="stat"><b>${esc(c.value)}${c.unit ? ` ${esc(c.unit)}` : ""}</b> ${esc(c.label ?? c.title)}</p>`;
    case "code":
      return `${title}<pre>${esc(c.code)}</pre>`;
    case "timeline":
      return `${title}<ol>${arr(c.items).map((i) => `<li><b>${esc((i as { time?: unknown }).time)}</b> ${esc((i as { title?: unknown }).title)}${(i as { detail?: unknown }).detail ? ` — ${esc((i as { detail?: unknown }).detail)}` : ""}</li>`).join("")}</ol>`;
    case "chart":
    case "JBarChart":
    case "JLineChart": {
      const labels = arr(c.labels);
      const series = arr(c.series) as { name?: unknown; values?: unknown[] }[];
      return `${title || "<h4>Chart</h4>"}${table(["", ...series.map((s) => String(s.name ?? ""))], labels.map((l, i) => [l, ...series.map((s) => s.values?.[i])]))}`;
    }
    case "markdown":
      return `<p>${esc(c.text ?? c.markdown)}</p>`;
    default:
      return `${title}<p class="note">(${esc(item.kind)}: shown in Friend)</p>`;
  }
}

const CSS = `:root{--bg:#0a101c;--ink:#e8f4ff;--accent:#3fd8ff;--edge:rgba(120,200,255,.3)}
@media (prefers-color-scheme: light){:root{--bg:#f4f8fc;--ink:#10202e;--accent:#0a7aa5;--edge:rgba(10,90,130,.3)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.45 system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column}
.slide{display:none;flex:1;padding:6vh 8vw;flex-direction:column;gap:16px}.slide.on{display:flex}
h1{margin:0;color:var(--accent);font-size:clamp(26px,4vw,52px)}.bullet{margin:.2em 0;font-size:clamp(18px,2.2vw,30px);padding-left:1em;position:relative}
.bullet:before{content:"";position:absolute;left:0;top:.6em;width:.4em;height:.4em;border-radius:50%;background:var(--accent)}
blockquote{margin:0;border-left:3px solid var(--accent);padding-left:16px;font-style:italic;font-size:clamp(20px,2.6vw,34px)}
table{border-collapse:collapse}th,td{border:1px solid var(--edge);padding:6px 12px;text-align:left}pre{background:rgba(127,127,127,.15);padding:12px;border-radius:8px;overflow:auto}
.item{display:none}.item.shown{display:block}.note{opacity:.7}
.caption{padding:10px 8vw;border-top:1px solid var(--edge);min-height:3.2em;opacity:.9}.bar{padding:6px 8vw 12px;opacity:.7;font-size:14px}.notes{opacity:.6;font-size:14px;margin-top:auto}
@keyframes fade{from{opacity:0}to{opacity:1}}@keyframes sl{from{opacity:0;transform:translateX(-36px)}to{opacity:1;transform:none}}@keyframes su{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
@keyframes gr{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}@keyframes ty{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
.anim-fade{animation:fade .6s both}.anim-slide-left{animation:sl .55s both}.anim-slide-up{animation:su .55s both}.anim-grow{animation:gr .5s both}.anim-type{animation:ty 1.2s steps(28,end) both}.anim-draw{animation:ty 1.1s both}
@media (prefers-reduced-motion: reduce){[class*="anim-"]{animation:none!important}}`;

const JS = `(function(){var S=[].slice.call(document.querySelectorAll('.slide')),s=0,i=0,cap=document.getElementById('cap'),bar=document.getElementById('bar');
function items(){return S[s].querySelectorAll('.item')}
function draw(){S.forEach(function(e,k){e.classList.toggle('on',k===s)});var it=items();for(var k=0;k<it.length;k++)it[k].classList.toggle('shown',k<i);
cap.textContent=i>0&&it[i-1]?it[i-1].getAttribute('data-say'):'';bar.textContent=(s+1)+' / '+S.length+'   (arrow keys, space or click)'}
function next(){var n=items().length;if(i<n){i++}else if(s<S.length-1){s++;i=0}draw()}
function back(){if(i>0){i--}else if(s>0){s--;i=items().length}draw()}
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key===' '||e.key==='Enter')next();else if(e.key==='ArrowLeft'||e.key==='Backspace')back()});
document.addEventListener('click',next);draw()})();`;

/** One file that plays on its own in any browser: the slides reveal one item at a time with the animations, the spoken lines show as captions. */
export function deckToHtml(deck: Deck): string {
  const slides = deck.slides
    .map((s) => {
      const items = s.items.map((it) => `<div class="item${it.animation && it.animation !== "none" ? ` anim-${it.animation}` : ""}" data-say="${esc(it.say)}">${body(it)}</div>`).join("");
      return `<section class="slide"><h1>${esc(s.title)}</h1>${items}${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ""}</section>`;
    })
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(deck.title)}</title><style>${CSS}</style></head><body>${slides}<div class="caption" id="cap" aria-live="polite"></div><div class="bar" id="bar"></div><script>${JS}</script></body></html>`;
}
