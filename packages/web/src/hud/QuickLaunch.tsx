import type { HudView } from "@friend/protocol";
import { useEffect, useRef, useState } from "react";
import { Movable } from "../layout/Movable";
import { ripple } from "./fx";

export type LauncherItem = HudView["launcher"][number];
type Anim = HudView["animations"];

/**
 * The quick-launch buttons: a stack of angled tabs, one for each button the owner set up in Settings. On hover a tab slides in, its
 * underline grows and a light sweeps across; pressing it ripples from the pointer, a scan line crosses it and its label flickers to
 * "ENGAGED". What a button does (open an address, ask the assistant, open a panel, control the music) is up to the caller.
 */
export function QuickLaunch({ items, animations, onAction }: { items: LauncherItem[]; animations: Anim; onAction: (item: LauncherItem) => void }) {
  const [engaged, setEngaged] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (items.length === 0) return null;
  const fire = (item: LauncherItem) => {
    if (animations !== "off") {
      setEngaged(item.id);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setEngaged(null), 650);
    }
    onAction(item);
  };
  return (
    <Movable id="launcher" label="Quick launch" wholeBox testId="launcher" className={`hud hud-launcher${animations === "full" ? " hud-boot" : ""}`}>
      <div className="hud-kicker">Quick launch</div>
      <ul className="hud-stack">
        {items.map((item, i) => (
          <li key={item.id} className={`hud-tab hud-cut${engaged === item.id ? " engaged" : ""}${animations === "full" ? " hud-boot" : ""}`} style={{ ["--i" as string]: i + 1 }}>
            <button type="button" className="hud-tab-main" aria-label={item.label} onPointerDown={animations === "off" ? undefined : ripple} onClick={() => fire(item)}>
              <span className="hud-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="hud-tab-label">{item.label}</span>
              <span className="hud-tab-engaged" aria-hidden="true">
                ENGAGED
              </span>
              <span className="hud-sweep" aria-hidden="true" />
              <span className="hud-scan" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </Movable>
  );
}
