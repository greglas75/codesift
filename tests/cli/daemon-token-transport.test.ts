import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeJsonFile, writeSecretFile } from "../../src/cli/setup/fs.js";
import {
  daemonHttpUrl,
  isLoopbackHost,
  buildJsonServerEntry,
  assertTokenTransportIsSafe,
} from "../../src/cli/setup/mcp.js";

describe("isLoopbackHost", () => {
  it("recognises the loopback forms", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it("does not treat a routable host as loopback", () => {
    for (const h of ["100.69.215.9", "example.com", "fd7a:115c:a1e0::1", "0.0.0.0"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it("does not treat a hostname that merely STARTS with 127. as loopback", () => {
    // A prefix test made these read as loopback, which posted the bearer token to whatever
    // the name resolves to — a bypass of the guard, inside the guard.
    for (const h of [
      "127.attacker.example",
      "127.0.0.1.attacker.example",
      "127.0.0.1.nip.io",
    ]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it("does not treat a userinfo payload as loopback", () => {
    // `127.0.0.1@evil.example` looks local and connects to evil.example.
    expect(isLoopbackHost("127.0.0.1@attacker.example")).toBe(false);
  });

  it("recognises both spellings of the IPv4-mapped loopback", () => {
    // Same address, two notations. Recognising only the dotted one rejected a valid local
    // config in a way nobody would think to diagnose.
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::ffff:7f00:1")).toBe(true);
    expect(isLoopbackHost("0:0:0:0:0:ffff:7f00:1")).toBe(true);
  });

  it("does not treat a mapped NON-loopback address as loopback", () => {
    expect(isLoopbackHost("::ffff:8.8.8.8")).toBe(false);
    expect(isLoopbackHost("::ffff:0808:0808")).toBe(false);
  });

  it("only strips brackets as a matched pair", () => {
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("[::1")).toBe(false);
    expect(isLoopbackHost("127.0.0.1]")).toBe(false);
  });
});

describe("one loopback definition across bind, install and setup", () => {
  // There were three copies with different semantics: server.ts and cli/service.ts each had a
  // 3-string set, cli/setup/mcp.ts had the full one. Binding to 127.0.0.2 — an ordinary loopback
  // alias, the usual way to run two daemons on one port — was accepted by setup and refused by
  // the server as "non-loopback without a token": a deployment valid at one layer, unstartable
  // at another.
  it("treats the whole 127.0.0.0/8 range as loopback, not just 127.0.0.1", () => {
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("127.53.1.9")).toBe(true);
  });

  it("still refuses everything genuinely routable", () => {
    // Unifying widened the no-token bind set, so this is the direction that must not leak:
    // these are exactly the addresses a token is protecting.
    for (const h of ["0.0.0.0", "100.69.215.9", "192.168.1.10", "10.0.0.1", "::", "fd7a::1"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it("service, setup and the shared module agree", async () => {
    const shared = await import("../../src/utils/loopback.js");
    const service = await import("../../src/cli/service.js");
    for (const h of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "0.0.0.0", "100.69.215.9"]) {
      expect(service.isLoopbackHost(h)).toBe(shared.isLoopbackHost(h));
      expect(isLoopbackHost(h)).toBe(shared.isLoopbackHost(h));
    }
  });
});

describe("host validation", () => {
  it("rejects a host carrying URL userinfo", () => {
    expect(() => daemonHttpUrl(7077, "/repo", "127.0.0.1@attacker.example")).toThrow(/cannot contain/i);
    expect(() =>
      assertTokenTransportIsSafe({
        http: true,
        host: "127.0.0.1@attacker.example",
        token: "secret",
      }),
    ).toThrow(/cannot contain/i);
  });

  it("rejects a host carrying path or query separators", () => {
    for (const h of ["evil.example/x", "evil.example?x=1", "evil.example#f", "evil example"]) {
      expect(() => daemonHttpUrl(7077, "/repo", h)).toThrow(/cannot contain/i);
    }
  });

  it("still refuses a plaintext token for a 127-prefixed HOSTNAME", () => {
    // The end-to-end version of the bypass: guard must fire, not exempt.
    expect(() =>
      assertTokenTransportIsSafe({ http: true, host: "127.attacker.example", token: "secret" }),
    ).toThrow(/plaintext/i);
  });
});

describe("daemonHttpUrl", () => {
  it("brackets IPv6 literals so the authority parses", () => {
    // Plain concatenation produced `http://::1:7077/mcp`, which is not a valid authority —
    // an IPv6 daemon could not be configured at all.
    const url = daemonHttpUrl(7077, "/repo", "::1");
    expect(url.startsWith("http://[::1]:7077/mcp")).toBe(true);
    expect(() => new URL(url)).not.toThrow();
  });

  it("does not double-bracket an already-bracketed host", () => {
    expect(daemonHttpUrl(7077, "/repo", "[::1]").startsWith("http://[::1]:7077/mcp")).toBe(true);
  });

  it("honours an https scheme", () => {
    expect(daemonHttpUrl(7077, "/repo", "example.com", "https")).toMatch(/^https:\/\/example\.com:7077\/mcp/);
  });

  it("keeps the cwd query parameter encoded", () => {
    const url = new URL(daemonHttpUrl(7077, "/repo with space/x", "127.0.0.1"));
    expect(url.searchParams.get("cwd")).toBe("/repo with space/x");
  });
});

describe("token at rest", () => {
  // The transport guard covers the token on the wire. These cover it on disk — the same
  // credential, and the shared-host scenario this feature enables is exactly where a
  // world-readable config hands it to every other local account.
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codesift-secret-mode-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writeJsonFile creates the file owner-readable only", async () => {
    const p = join(dir, "claude.json");
    await writeJsonFile(p, { mcpServers: { codesift: { headers: { Authorization: "Bearer s" } } } });
    expect((statSync(p).mode & 0o777).toString(8)).toBe("600");
  });

  it("writeSecretFile creates the file owner-readable only", async () => {
    const p = join(dir, "config.toml");
    await writeSecretFile(p, 'Authorization = "Bearer secret"\n');
    expect((statSync(p).mode & 0o777).toString(8)).toBe("600");
  });

  it("tightens an existing world-readable config on rewrite", async () => {
    // `mode` only applies at creation, so a config written by an older version keeps 0644
    // until something chmods it. Rewriting must not leave it open.
    const p = join(dir, "pre-existing.json");
    writeFileSync(p, "{}", { mode: 0o644 });
    expect((statSync(p).mode & 0o777).toString(8)).toBe("644");

    await writeJsonFile(p, { mcpServers: {} });
    expect((statSync(p).mode & 0o777).toString(8)).toBe("600");
  });
});

describe("bearer token transport guard", () => {
  it("refuses a token on a plaintext link to another machine", () => {
    // Requiring a token does not make a routable plaintext endpoint safe: the token is static
    // and replayable, and whoever captures it can read every indexed repo on that daemon.
    expect(() =>
      assertTokenTransportIsSafe({ http: true, host: "100.69.215.9", token: "secret" }),
    ).toThrow(/plaintext/i);
  });

  it("allows it over https", () => {
    expect(() =>
      assertTokenTransportIsSafe({
        http: true,
        host: "100.69.215.9",
        token: "secret",
        scheme: "https",
      }),
    ).not.toThrow();
  });

  it("allows it when the operator states the link is already encrypted", () => {
    expect(() =>
      assertTokenTransportIsSafe({
        http: true,
        host: "100.69.215.9",
        token: "secret",
        insecureTransport: true,
      }),
    ).not.toThrow();
  });

  it("allows plaintext on loopback — nothing leaves the host", () => {
    expect(() =>
      assertTokenTransportIsSafe({ http: true, host: "127.0.0.1", token: "secret" }),
    ).not.toThrow();
  });

  it("allows a remote daemon with no token at all", () => {
    expect(() =>
      assertTokenTransportIsSafe({ http: true, host: "100.69.215.9" }),
    ).not.toThrow();
  });

  it("buildJsonServerEntry enforces the guard", () => {
    expect(() =>
      buildJsonServerEntry({ http: true, host: "100.69.215.9", token: "secret" }),
    ).toThrow(/plaintext/i);
  });

  it("buildJsonServerEntry still writes the header when the transport is acceptable", () => {
    const entry = buildJsonServerEntry({
      http: true,
      host: "100.69.215.9",
      token: "secret",
      scheme: "https",
      cwd: "/repo",
    });
    expect(entry["headers"]).toEqual({ Authorization: "Bearer secret" });
    expect(String(entry["url"]).startsWith("https://")).toBe(true);
  });
});
