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

/** The sentences a refusal uses, so the same rule can speak about a video or about a web page. */
interface Words {
  scheme: string;
  login: string;
  port: string;
  inside: string;
}
const VIDEO: Words = {
  scheme: "Only http and https links can be played.",
  login: "A link with a login in it cannot be played.",
  port: "Links with an odd port cannot be played.",
  inside: "That address is on this PC or your network, so Friend will not play it.",
};
const PAGE: Words = {
  scheme: "Only http and https links can be opened.",
  login: "A link with a login in it cannot be opened.",
  port: "Links with an odd port cannot be opened.",
  inside: "That address is on this PC or your network, so Friend will not open it.",
};
const NOT_AN_ADDRESS = "That is not a web address.";

/**
 * Whether Friend may start fetching this link. The same rule at every step: a plain http or https address of a public name, with no
 * login and no odd port, that resolves only to public addresses. It is what stands between a link someone sends and the owner's own
 * network, so every sentence it gives is the same one however the link points inside: it never repeats the address.
 */
async function vet(raw: string, d: VetDeps, say: Words, sitesHint: string): Promise<Vetted> {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > 2000) return { ok: false, error: NOT_AN_ADDRESS };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: NOT_AN_ADDRESS };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: say.scheme };
  if (u.username || u.password) return { ok: false, error: say.login };
  if (u.port) return { ok: false, error: say.port };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, error: NOT_AN_ADDRESS };
  const bare = host.replace(/^\[|\]$/g, "");
  if (host.startsWith("[") || isIP(bare) !== 0 || /^[0-9.]+$/.test(host)) return { ok: false, error: say.inside };
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => l === "") || host === "localhost" || RESERVED.test(host)) return { ok: false, error: say.inside };

  const sites = d.ignoreSites ? [] : (d.allowedSites ?? []);
  if (sites.length && !sites.some((s) => host === s || host.endsWith(`.${s}`))) return { ok: false, error: `That site is not on your allowed list (${sites.join(", ")}). ${sitesHint}` };

  let addresses: string[];
  try {
    addresses = await (d.resolve ?? resolveAll)(host);
  } catch {
    return { ok: false, error: "Friend could not find that site." };
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) return { ok: false, error: say.inside };
  return { ok: true, url: u.toString(), host };
}

/** A link to play as a video: public, and on the owner's list of sites when there is one. */
export const vetVideoUrl = (raw: string, d: VetDeps = {}): Promise<Vetted> => vet(raw, d, VIDEO, "Add it in Settings, Web video.");

/** A link to open as a web page (web.read and every redirect on the way): public, no list of sites. */
export const vetPublicUrl = (raw: string, d: Pick<VetDeps, "resolve"> = {}): Promise<Vetted> => vet(raw, { resolve: d.resolve }, PAGE, "");
