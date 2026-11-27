import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sealText, unsealText } from "../secretBox";

export interface VaultEntry {
  tokens?: unknown;
  clientInfo?: unknown;
  /** The authorization server these belong to. Never presented to another. */
  issuer?: string;
  account?: string;
  scopes?: string[];
  discovery?: unknown;
  verifier?: string;
  needsReconnect?: boolean;
  /** A client secret the owner typed for a known service (write-only). */
  clientSecret?: string;
  /** A mailbox login (write-only), under the key `mail:<account id>`. */
  secret?: string;
}

/**
 * Every connected login in one sealed file in the data folder. Keys: `mcp:<connector id>` or `svc:<service id>`.
 * What it holds never reaches a screen, a log or the assistant.
 */
export class OAuthVault {
  private path: string;
  private all: Record<string, VaultEntry>;

  constructor(private dataDir: string) {
    this.path = join(dataDir, "oauth-vault.json");
    this.all = this.load();
  }

  private load(): Record<string, VaultEntry> {
    if (!existsSync(this.path)) return {};
    try {
      const text = unsealText(readFileSync(this.path, "utf8"), this.dataDir);
      const j = text ? (JSON.parse(text) as unknown) : null;
      return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, VaultEntry>) : {};
    } catch {
      return {}; // a damaged file counts as empty rather than stopping Friend
    }
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, sealText(JSON.stringify(this.all), this.dataDir), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* permission bits unsupported on this system */
    }
    renameSync(tmp, this.path);
  }

  get(key: string): VaultEntry {
    return structuredClone(this.all[key] ?? {});
  }

  has(key: string): boolean {
    return key in this.all;
  }

  keys(): string[] {
    return Object.keys(this.all);
  }

  /** Merges fields. A different authorization server drops the old login and client: they are only good where they were issued. */
  patch(key: string, p: Partial<VaultEntry>): void {
    const cur = this.all[key] ?? {};
    const moved = p.issuer !== undefined && cur.issuer !== undefined && p.issuer !== cur.issuer;
    const base: VaultEntry = moved ? { clientSecret: cur.clientSecret } : cur;
    this.all[key] = structuredClone({ ...base, ...p });
    this.save();
  }

  forget(key: string): void {
    if (!(key in this.all)) return;
    delete this.all[key];
    this.save();
  }
}
