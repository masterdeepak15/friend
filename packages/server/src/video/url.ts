import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress } from "../music/audius";

export interface VetDeps {
  /** Looks a name up (default: the system's). Every address it gives must be a public one. */
  resolve?: (host: string) => Promise<string[]>;
  /** The owner's list of sites: empty means any public site. */
  allowedSites?: readonly string[];
  /** For the media addresses a site hands out (they live on other hosts, such as a video network): the list is not applied, the public-address rule still is. */
  ignoreSites?: boolean;
}

export type Vetted = { ok: true; url: string; host: string } | { ok: false; error: string };

const resolveAll = async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map((r) => r.address);
const RESERVED = /\.(local|localhost|localdomain|internal|lan|home|corp|intranet|test|example|invalid|arpa|onion)$/;
const OWN_NETWORK = "That address is on this PC or your network, so Friend will not play it.";

/**
 * Whether Friend may start fetching this link. The same rule at every step: a plain http or https address of a public name, with no
 * login and no odd port, that resolves only to public addresses. It is what stands between a link someone sends and the owner's own
 * network, so every sentence it gives is the same one however the link points inside: it never repeats the address.
 */
export async function vetVideoUrl(raw: string, d: VetDeps = {}): Promise<Vetted> {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > 2000) return { ok: false, error: "That is not a web address." };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: "That is not a web address." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "Only http and https links can be played." };
  if (u.username || u.password) return { ok: false, error: "A link with a login in it cannot be played." };
  if (u.port) return { ok: false, error: "Links with an odd port cannot be played." };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, error: "That is not a web address." };
  const bare = host.replace(/^\[|\]$/g, "");
  if (host.startsWith("[") || isIP(bare) !== 0 || /^[0-9.]+$/.test(host)) return { ok: false, error: OWN_NETWORK };
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => l === "") || host === "localhost" || RESERVED.test(host)) return { ok: false, error: OWN_NETWORK };

  const sites = d.ignoreSites ? [] : (d.allowedSites ?? []);
  if (sites.length && !sites.some((s) => host === s || host.endsWith(`.${s}`))) return { ok: false, error: `That site is not on your allowed list (${sites.join(", ")}). Add it in Settings, Web video.` };

  let addresses: string[];
  try {
    addresses = await (d.resolve ?? resolveAll)(host);
  } catch {
    return { ok: false, error: "Friend could not find that site." };
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) return { ok: false, error: OWN_NETWORK };
  return { ok: true, url: u.toString(), host };
}
