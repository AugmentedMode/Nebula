import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getNebulaDir } from "../../store/database.js";
import type { AuthCredentials } from "../types.js";

const AUTH_FILE = "auth.json";

interface StoredAuth {
  claude?: AuthCredentials;
  openai?: AuthCredentials;
}

export class TokenStore {
  private filePath: string;
  private data: StoredAuth;

  constructor() {
    const dir = join(getNebulaDir(), "auth");
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, AUTH_FILE);
    this.data = this.load();
  }

  private load(): StoredAuth {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw) as StoredAuth;
    } catch {
      return {};
    }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  get(provider: "claude" | "openai"): AuthCredentials | null {
    return this.data[provider] ?? null;
  }

  set(provider: "claude" | "openai", creds: AuthCredentials): void {
    this.data[provider] = creds;
    this.save();
  }

  clear(provider: "claude" | "openai"): void {
    delete this.data[provider];
    this.save();
  }

  isExpired(provider: "claude" | "openai"): boolean {
    const creds = this.data[provider];
    if (!creds?.expiresAt) return false;
    return Date.now() >= creds.expiresAt;
  }

  needsRefresh(provider: "claude" | "openai"): boolean {
    const creds = this.data[provider];
    if (!creds) return true;
    if (creds.method === "api_key") return false;
    if (!creds.expiresAt) return false;
    // Refresh 5 minutes before expiry
    return Date.now() >= creds.expiresAt - 5 * 60 * 1000;
  }
}
