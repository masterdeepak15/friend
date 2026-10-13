import type { ReactNode } from "react";
import type { SettingsView } from "./settingsApi";

type Web = NonNullable<SettingsView["web"]>;

const SOURCES: { id: Web["provider"]; label: string }[] = [
  { id: "duckduckgo", label: "DuckDuckGo (free, no key)" },
  { id: "brave", label: "Brave Search (your key)" },
  { id: "tavily", label: "Tavily (your key)" },
  { id: "searxng", label: "SearXNG (your own server)" },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      {children}
      {hint && <small className="auth-note">{hint}</small>}
    </label>
  );
}

/**
 * Searching the web (web.search and web.read) for every model. The source and the on/off switch are saved with the other
 * settings; a key is write-only: it is never shown, and an empty box leaves the saved one alone.
 */
export function WebSection({ web, saved, braveKey, tavilyKey, onChange, onBraveKey, onTavilyKey }: { web: Web; saved: Web; braveKey: string; tavilyKey: string; onChange: (patch: Partial<Web>) => void; onBraveKey: (v: string) => void; onTavilyKey: (v: string) => void }) {
  return (
    <>
      <h4 className="plugins-heading">Searching the web</h4>
      <label className="settings-check">
        <input type="checkbox" checked={web.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} /> Let Friend search the web
      </label>
      <p className="auth-note">Gives every model web.search (a list of results) and web.read (the text of one page), for prices, news and anything else that changes. They run on this PC with no browser. Friend will never take orders from a page, and it will not open addresses on this PC or your network.</p>
      <Field label="Search source">
        <select value={web.provider} disabled={!web.enabled} onChange={(e) => onChange({ provider: e.target.value as Web["provider"] })}>
          {SOURCES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      {web.provider === "brave" && (
        <Field label="Brave key" hint={saved.braveKeySet ? "A key is saved. Type a new one only to replace it." : "From your Brave Search API account."}>
          <input type="password" autoComplete="off" placeholder={saved.braveKeySet ? "saved" : ""} value={braveKey} onChange={(e) => onBraveKey(e.target.value)} />
        </Field>
      )}
      {web.provider === "tavily" && (
        <Field label="Tavily key" hint={saved.tavilyKeySet ? "A key is saved. Type a new one only to replace it." : "From your Tavily account."}>
          <input type="password" autoComplete="off" placeholder={saved.tavilyKeySet ? "saved" : ""} value={tavilyKey} onChange={(e) => onTavilyKey(e.target.value)} />
        </Field>
      )}
      {web.provider === "searxng" && (
        <Field label="SearXNG address" hint="For example http://localhost:8080. It must allow the JSON format.">
          <input value={web.searxngUrl} onChange={(e) => onChange({ searxngUrl: e.target.value })} />
        </Field>
      )}
      {web.provider !== "duckduckgo" && <p className="auth-note">If this source cannot answer, Friend tries DuckDuckGo once and says so.</p>}
    </>
  );
}
