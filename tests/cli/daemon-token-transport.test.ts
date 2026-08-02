import { describe, it, expect } from "vitest";
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

  it("recognises the IPv4-mapped IPv6 loopback", () => {
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
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
