import DOMPurify from "dompurify";
import { marked } from "marked";

let hooked = false;
function ensureHook(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof Element && node.tagName === "A") {
      node.setAttribute("rel", "noopener noreferrer");
      node.setAttribute("target", "_blank");
    }
  });
}

/** Markdown to safe HTML: no scripts, no raw images, no inline handlers, no javascript: URLs. */
export function sanitizeMarkdown(src: string): string {
  ensureHook();
  const html = marked.parse(src, { async: false, breaks: true }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "code", "pre", "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "hr", "del", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["href", "rel", "target"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
}
