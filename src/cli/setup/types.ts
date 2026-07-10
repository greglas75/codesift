export interface SetupResult {
  platform: string;
  config_path: string;
  status: "created" | "updated" | "already_configured";
  note?: string;
}

export interface InstallRulesResult {
  path: string;
  action: "created" | "updated" | "skipped" | "force-updated" | "error";
  warning?: string;
  error?: string;
}

export interface SetupOptions {
  hooks?: boolean;
  rules?: boolean;
  force?: boolean;
  /** Install the shared post-commit hook when editor hooks are enabled. */
  gitHooks?: boolean;
  /** Write shared-daemon HTTP client config instead of stdio config. */
  http?: boolean;
  /** Shared-daemon port; defaults to 7077. */
  port?: number;
}
