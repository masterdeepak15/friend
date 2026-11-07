export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
  /** A folder inside the repository, when the link points at one. */
  folder?: string;
}

export interface Limits {
  /** Milliseconds for one request. */
  requestMs: number;
  /** Bytes read from the repository in total, by one reader. */
  totalBytes: number;
  /** Files read by one reader. */
  files: number;
  /** Bytes in one file. */
  fileBytes: number;
}
export const DEFAULT_LIMITS: Limits = { requestMs: 15_000, totalBytes: 2 * 1024 * 1024, files: 60, fileBytes: 200 * 1024 };

export interface Bases {
  api: string;
  raw: string;
  web: string;
}
const GITHUB: Bases = { api: "https://api.github.com", raw: "https://raw.githubusercontent.com", web: "https://github.com" };

export type GithubReason = "host" | "limit" | "rate" | "offline" | "missing" | "binary" | "path";
export class GithubError extends Error {
  constructor(
    public reason: GithubReason,
    message: string,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** `https://github.com/o/r[.git]`, `…/tree/<ref>/<folder>` or `o/r`. Anything else (another host, another scheme) is null. */
export function parseRepoLink(input: string): RepoRef | null {
  const text = input.trim();
  let path: string;
  if (/^https:\/\/github\.com\//i.test(text)) path = text.replace(/^https:\/\/github\.com\//i, "");
  else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) path = text;
  else return null;
  const parts = path.split(/[?#]/)[0]!.split("/").filter((p, i, a) => p !== "" || i < a.length - 1);
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  if (!NAME.test(owner) || !NAME.test(repo)) return null;
  if (parts.length === 2) return { owner, repo };
  if (parts[2] === "tree" && parts.length >= 4) {
    const folder = parts.slice(4).join("/");
    if (parts.slice(4).some((p) => p === ".." || p === "." || p === "")) return null;
    return { owner, repo, ref: decodeURIComponent(parts[3]!), ...(folder ? { folder } : {}) };
  }
  return null;
}

/** A path inside a repository: no way out of it, no empty parts, no backslashes. */
function cleanPath(path: string): string | null {
  if (!path || path.startsWith("/") || path.includes("\\") || /^[a-zA-Z]:/.test(path)) return null;
  const parts = path.split("/");
  return parts.some((p) => p === "" || p === "." || p === "..") ? null : parts.map(encodeURIComponent).join("/");
}

/**
 * Reads a public GitHub repository, and nothing else: three hosts, https, a time limit on every request, and hard limits on how much one
 * reader will take. Everything it returns is text from the internet: data, never instructions.
 */
export class GithubReader {
  private base: Bases;
  private limits: Limits;
  private origins: Set<string>;
  private doFetch: typeof fetch;
  private files = 0;
  private bytes = 0;
  private commits = new Map<string, string>();

  constructor(d: { base?: Bases; fetch?: typeof fetch; limits?: Partial<Limits> } = {}) {
    this.base = d.base ?? GITHUB;
    this.limits = { ...DEFAULT_LIMITS, ...d.limits };
    this.doFetch = d.fetch ?? fetch;
    this.origins = new Set(Object.values(this.base).map((u) => new URL(u).origin));
  }

  private key(r: RepoRef): string {
    return `${r.owner}/${r.repo}`;
  }

  /** One request to an allowed host. A redirect is followed only to another allowed host. */
  private async get(url: string): Promise<Response> {
    let current = url;
    for (let hops = 0; hops < 4; hops++) {
      if (!this.origins.has(new URL(current).origin)) throw new GithubError("host", "Friend reads only from GitHub, and that link goes somewhere else.");
      let res: Response;
      try {
        res = await this.doFetch(current, { redirect: "manual", signal: AbortSignal.timeout(this.limits.requestMs), headers: { accept: "application/vnd.github+json", "user-agent": "friend-assistant" } });
      } catch {
        throw new GithubError("offline", "Friend could not reach GitHub (no network, or it did not answer in time).");
      }
      if (res.status >= 300 && res.status < 400) {
        const to = res.headers.get("location");
        if (!to) throw new GithubError("missing", "GitHub sent an empty redirect.");
        current = new URL(to, current).toString();
        continue;
      }
      if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const when = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toLocaleTimeString() : "later";
        throw new GithubError("rate", `GitHub's limit for reading without an account is used up; try again after ${when}.`);
      }
      if (res.status === 404) throw new GithubError("missing", "GitHub does not have that (the link may be wrong, or the repository is private).");
      if (!res.ok) throw new GithubError("offline", `GitHub answered with an error (${res.status}).`);
      return res;
    }
    throw new GithubError("host", "Too many redirects.");
  }

  /** Every file in the repository (not folders), and the commit they belong to. Listing costs nothing against the reading limits. */
  async tree(r: RepoRef): Promise<{ commit: string; files: { path: string; size: number }[] }> {
    const ref = r.ref ?? "HEAD";
    const commit = ((await (await this.get(`${this.base.api}/repos/${r.owner}/${r.repo}/commits/${encodeURIComponent(ref)}`)).json()) as { sha?: string }).sha;
    if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) throw new GithubError("missing", "GitHub did not give a commit for that repository.");
    this.commits.set(this.key(r), commit);
    const body = (await (await this.get(`${this.base.api}/repos/${r.owner}/${r.repo}/git/trees/${commit}?recursive=1`)).json()) as { tree?: { path: string; type: string; size?: number }[] };
    return { commit, files: (body.tree ?? []).filter((t) => t.type === "blob").map((t) => ({ path: t.path, size: t.size ?? 0 })) };
  }

  /** One text file. Counts against the limits of this reader. */
  async file(r: RepoRef, path: string, maxBytes = this.limits.fileBytes): Promise<string> {
    const safe = cleanPath(path);
    if (!safe) throw new GithubError("path", `"${path}" is not a file inside the repository.`);
    if (this.files >= this.limits.files) throw new GithubError("limit", `That is ${this.limits.files} files; Friend stops reading there.`);
    const at = r.ref && /^[0-9a-f]{40}$/i.test(r.ref) ? r.ref : (this.commits.get(this.key(r)) ?? r.ref ?? "HEAD");
    const res = await this.get(`${this.base.raw}/${r.owner}/${r.repo}/${encodeURIComponent(at)}/${safe}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new GithubError("limit", `"${path}" is larger than ${Math.round(maxBytes / 1024)} KB.`);
    if (this.bytes + buf.length > this.limits.totalBytes) throw new GithubError("limit", `That is more than ${Math.round(this.limits.totalBytes / 1024)} KB read in one go; Friend stops there.`);
    if (buf.subarray(0, 8192).includes(0)) throw new GithubError("binary", `"${path}" is not a text file.`);
    this.files++;
    this.bytes += buf.length;
    return buf.toString("utf8");
  }
}
