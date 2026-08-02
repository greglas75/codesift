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
  /**
   * Project directory to pin into the daemon URL. Defaults to the CWD.
   * An HTTP entry is per-project by construction — see `daemonHttpUrl`.
   */
  cwd?: string;
  /**
   * Daemon host. Defaults to 127.0.0.1 (a local daemon). Point it at a shared
   * instance to have several machines served by one process — the reason
   * stateless serving exists.
   */
  host?: string;
  /**
   * Bearer token for a remote daemon. The server refuses a routable bind
   * without one, so a remote setup needs it.
   */
  token?: string;
  /** Shared-daemon port; defaults to 7077. */
  port?: number;
  /** URL scheme for the daemon endpoint. Defaults to http (correct for loopback). */
  scheme?: "http" | "https";
  /**
   * Acknowledge that a plaintext link to a NON-loopback daemon is already encrypted below HTTP
   * (tailnet, VPN, SSH tunnel). Without it, writing a bearer token onto such a URL is refused —
   * the code cannot tell a tailnet address from a public one, so the operator has to say so.
   */
  insecureTransport?: boolean;
}
