import { execFileSync } from "node:child_process";

export interface LspServerConfig {
  command: string;
  args: string[];
  languages: string[];
  initOptions?: Record<string, unknown>;
}

export const LSP_SERVERS: Record<string, LspServerConfig> = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    languages: ["typescript", "javascript", "tsx", "jsx"],
  },
  python: {
    command: "pylsp",
    args: [],
    languages: ["python"],
  },
  go: {
    command: "gopls",
    args: ["serve"],
    languages: ["go"],
  },
  rust: {
    command: "rust-analyzer",
    args: [],
    languages: ["rust"],
  },
  ruby: {
    command: "solargraph",
    args: ["stdio"],
    languages: ["ruby"],
  },
  php: {
    command: "intelephense",
    args: ["--stdio"],
    languages: ["php"],
  },
  kotlin: {
    command: "kotlin-language-server",
    args: [],
    languages: ["kotlin"],
  },
};

export function getLspConfigForLanguage(language: string): { name: string; config: LspServerConfig } | null {
  for (const [name, config] of Object.entries(LSP_SERVERS)) {
    if (config.languages.includes(language)) {
      return { name, config };
    }
  }
  return null;
}

const availabilityCache = new Map<string, boolean>();

export function isLspAvailable(config: LspServerConfig): boolean {
  const cached = availabilityCache.get(config.command);
  if (cached !== undefined) return cached;

  try {
    execFileSync("which", [config.command], { stdio: "ignore" });
    availabilityCache.set(config.command, true);
    return true;
  } catch {
    availabilityCache.set(config.command, false);
    return false;
  }
}
