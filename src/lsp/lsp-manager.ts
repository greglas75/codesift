import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { LspClient } from "./lsp-client.js";
import { getLspConfigForLanguage, isLspAvailable } from "./lsp-servers.js";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 1000;

interface LspSession {
  client: LspClient;
  language: string;
  rootPath: string;
  lastUsed: number;
}

export class LspManager {
  private sessions = new Map<string, LspSession>();
  private reapTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.reapTimer = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS);
    if (this.reapTimer.unref) this.reapTimer.unref();
  }

  async getClient(rootPath: string, language: string): Promise<LspClient | null> {
    const key = `${rootPath}:${language}`;

    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.client;
    }

    const lspInfo = getLspConfigForLanguage(language);
    if (!lspInfo) return null;
    if (!isLspAvailable(lspInfo.config)) return null;

    try {
      const proc = spawn(lspInfo.config.command, lspInfo.config.args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: rootPath,
      });

      const client = new LspClient(proc);
      const rootUri = pathToFileURL(rootPath).href;
      await client.initialize(rootUri);

      const session: LspSession = {
        client,
        language,
        rootPath,
        lastUsed: Date.now(),
      };
      this.sessions.set(key, session);

      proc.on("exit", () => {
        this.sessions.delete(key);
      });

      return client;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[codesift] LSP start failed for ${lspInfo.name}: ${msg}`);
      return null;
    }
  }

  getServerName(language: string): string | null {
    const info = getLspConfigForLanguage(language);
    return info ? info.config.command : null;
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastUsed > IDLE_TIMEOUT_MS) {
        session.client.shutdown().catch(() => {});
        this.sessions.delete(key);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    const shutdowns = [...this.sessions.values()].map((s) =>
      s.client.shutdown().catch(() => {}),
    );
    await Promise.all(shutdowns);
    this.sessions.clear();
  }
}

let _manager: LspManager | null = null;

export function getLspManager(): LspManager {
  if (!_manager) _manager = new LspManager();
  return _manager;
}
