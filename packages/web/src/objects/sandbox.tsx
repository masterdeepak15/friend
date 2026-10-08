import { useMemo } from "react";

/**
 * What the page is allowed to do: run its own inline script and style, and show data: images. Nothing else.
 * default-src 'none' closes every route out (fetch, XHR, WebSocket, fonts, media, frames, workers), and form
 * submission and a changed <base> are closed too.
 */
const POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const BASE_STYLE = "html,body{margin:0;min-height:100%;background:#050b10;color:#d8f6ff;font:15px/1.5 system-ui,sans-serif}";

/**
 * The whole document the frame shows. The policy comes first and is a constant, so nothing the agent wrote can
 * come before it or change it (a second policy in the agent's page can only tighten, never loosen).
 */
export function buildSandboxDoc(html: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${POLICY}">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>${BASE_STYLE}</style></head><body>${html}</body></html>`
  );
}

/**
 * A page the agent wrote, running in an isolated frame. `sandbox="allow-scripts"` without `allow-same-origin`
 * gives it an empty origin: it cannot read this app's cookies or storage, call its APIs, navigate the window,
 * open popups or submit forms. The app never listens for messages from the frame.
 */
export function Sandbox({ props }: { props: Record<string, unknown> }) {
  const html = typeof props.html === "string" ? props.html : "";
  const title = typeof props.title === "string" ? props.title : "";
  const doc = useMemo(() => buildSandboxDoc(html), [html]);
  return (
    <div className="obj-sandbox">
      {title && <h3 className="obj-title">{title}</h3>}
      <iframe
        title={title || "Page made by Friend"}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow=""
        srcDoc={doc}
      />
    </div>
  );
}
