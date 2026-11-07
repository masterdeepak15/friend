import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GithubError, GithubReader, parseRepoLink } from "./github";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let servers: Server[] = [];
async function serve(handler: Handler): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

const SHA = "a".repeat(40);
const files: Record<string, string | Buffer> = {
  "README.md": "# Hello\nInstall me.",
  "plugin/skills/x/SKILL.md": "---\nname: x\n---\nDo x.",
  "bin/tool.png": Buffer.concat([Buffer.from("PNG"), Buffer.from([0, 1, 2])]),
  "big.txt": "y".repeat(300 * 1024),
};
const json = (res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
function fakeGithub(): Handler {
  return (req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/api/repos/o/r/commits/HEAD") return json(res, { sha: SHA });
    if (url.pathname === `/api/repos/o/r/git/trees/${SHA}`) return json(res, { tree: Object.keys(files).map((path) => ({ path, type: "blob", size: Buffer.byteLength(files[path]!) })).concat([{ path: "plugin", type: "tree", size: 0 }]), truncated: false });
    const m = /^\/raw\/o\/r\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (m && files[decodeURIComponent(m[2]!)] !== undefined) {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end(files[decodeURIComponent(m[2]!)]);
    }
    res.writeHead(404);
    res.end("nope");
  };
}
const readerFor = (origin: string, limits = {}) => new GithubReader({ base: { api: `${origin}/api`, raw: `${origin}/raw`, web: origin }, limits });
const repo = { owner: "o", repo: "r" };

describe("parseRepoLink", () => {
  it("accepts a GitHub link, a .git link, a folder link and owner/repo", () => {
    expect(parseRepoLink("https://github.com/lemomo-ai/lemo-opuscar.git")).toEqual({ owner: "lemomo-ai", repo: "lemo-opuscar" });
    expect(parseRepoLink("https://github.com/o/r")).toEqual({ owner: "o", repo: "r" });
    expect(parseRepoLink("https://github.com/o/r/tree/main/plugin/sub")).toEqual({ owner: "o", repo: "r", ref: "main", folder: "plugin/sub" });
    expect(parseRepoLink("o/r")).toEqual({ owner: "o", repo: "r" });
  });
  it("refuses another host, another scheme and nonsense", () => {
    for (const bad of ["https://evil.example/o/r", "http://github.com/o/r", "file:///etc/passwd", "o/r/extra", "", "https://github.com/o", "git@github.com:o/r.git"]) expect(parseRepoLink(bad)).toBeNull();
  });
});

describe("GithubReader", () => {
  let origin: string;
  beforeEach(async () => {
    origin = await serve(fakeGithub());
  });

  it("lists the files of a repository with the commit they are at", async () => {
    const t = await readerFor(origin).tree(repo);
    expect(t.commit).toBe(SHA);
    expect(t.files.map((f) => f.path)).toContain("README.md");
    expect(t.files.map((f) => f.path)).not.toContain("plugin"); // folders are not files
  });

  it("reads a text file, using the commit it listed", async () => {
    const r = readerFor(origin);
    await r.tree(repo);
    expect(await r.file(repo, "README.md")).toContain("Install me.");
  });

  it("refuses a path that leaves the repository, a binary file and a file that is too large", async () => {
    const r = readerFor(origin);
    await r.tree(repo);
    for (const p of ["../etc/passwd", "a/../../b", "/abs", "a\\b", ""]) await expect(r.file(repo, p)).rejects.toMatchObject({ reason: "path" });
    await expect(r.file(repo, "bin/tool.png")).rejects.toMatchObject({ reason: "binary" });
    await expect(r.file(repo, "big.txt")).rejects.toMatchObject({ reason: "limit" });
  });

  it("says a missing file is missing", async () => {
    const r = readerFor(origin);
    await r.tree(repo);
    await expect(r.file(repo, "nope.md")).rejects.toMatchObject({ reason: "missing" });
  });

  it("refuses to follow a redirect to another host", async () => {
    const other = await serve((_q, res) => void res.end("secret"));
    const o = await serve((req, res) => {
      if (req.url!.startsWith("/raw/")) {
        res.writeHead(302, { location: `${other}/steal` });
        return void res.end();
      }
      fakeGithub()(req, res);
    });
    const r = readerFor(o);
    await r.tree(repo);
    await expect(r.file(repo, "README.md")).rejects.toMatchObject({ reason: "host" });
  });

  it("stops after 60 files and after 2 MB in total", async () => {
    const r = readerFor(origin, { files: 3 });
    await r.tree(repo);
    await r.file(repo, "README.md");
    await r.file(repo, "README.md");
    await r.file(repo, "README.md");
    await expect(r.file(repo, "README.md")).rejects.toMatchObject({ reason: "limit" });
    const small = readerFor(origin, { totalBytes: 30 });
    await small.tree(repo);
    await small.file(repo, "README.md");
    await expect(small.file(repo, "plugin/skills/x/SKILL.md")).rejects.toMatchObject({ reason: "limit" });
  });

  it("explains a rate limit in plain words, with the time it ends", async () => {
    const o = await serve((_q, res) => {
      res.writeHead(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1800) });
      res.end("{}");
    });
    const err = await readerFor(o).tree(repo).catch((e) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect(err.reason).toBe("rate");
    expect(err.message).toMatch(/limit.*try again/i);
  });

  it("says so when GitHub cannot be reached", async () => {
    const dead = await serve(() => {});
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    servers = [];
    await expect(readerFor(dead).tree(repo)).rejects.toMatchObject({ reason: "offline" });
  });

  it("gives up on a request that never answers", async () => {
    const hang = await serve(() => {});
    await expect(new GithubReader({ base: { api: `${hang}/api`, raw: `${hang}/raw`, web: hang }, limits: { requestMs: 150 } }).tree(repo)).rejects.toMatchObject({ reason: "offline" });
  });
});
