import type { DomSet } from "./domKit";
import { MEET } from "./meetDom";
import { TEAMS } from "./teamsDom";
import { ZOOM } from "./zoomDom";

import type { Platform } from "./logic";

/** The scripts for one site. */
export function domFor(platform: Platform): DomSet {
  return platform === "meet" ? MEET : platform === "zoom" ? ZOOM : TEAMS;
}
