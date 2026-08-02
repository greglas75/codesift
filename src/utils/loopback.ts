/**
 * The single definition of "this address does not leave the machine".
 *
 * There were three: `server.ts` gated its bind on a 3-string set, `cli/service.ts` had its own
 * copy of the same 3 strings, and `cli/setup/mcp.ts` had a fuller one (all of 127.0.0.0/8 plus
 * the IPv4-mapped IPv6 forms). They disagreed, and the disagreement was reachable: binding the
 * daemon to `127.0.0.2` — a perfectly ordinary loopback alias, the usual way to run two daemons
 * on one port — was accepted by setup and refused by the server as "non-loopback without a
 * token". Safe direction, but a deployment that looks valid from one layer and cannot start at
 * another.
 *
 * A predicate that decides whether a credential may travel in plaintext should exist once.
 */
import { isIP } from "node:net";

/**
 * Literal addresses only.
 *
 * A prefix test like `/^127\./` reads as loopback for `127.attacker.example` and for
 * `127.0.0.1@attacker.example` (that `@` is URL userinfo, so the request goes to
 * `attacker.example`) — either one turns this exemption into a way to post a bearer token to an
 * attacker-controlled host. `isIP` returns 0 for anything that is not a bare address literal, so
 * the whole class falls through.
 *
 * `localhost` stays exempt. It is resolver-dependent in principle, but anyone who can rewrite
 * your hosts file already owns the machine, and dropping it would break the common local case in
 * exchange for a threat this does not mitigate.
 */
export function isLoopbackHost(host: string): boolean {
  // Strip brackets only as a matched pair: accepting a lone `[` or `]` let a malformed authority
  // like `[::1` classify as loopback here while failing later in URL construction.
  const trimmed = host.trim();
  const unwrapped = /^\[.*\]$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
  const bare = unwrapped.toLowerCase();

  if (bare === "localhost") return true;

  const kind = isIP(bare);
  if (kind === 4) return bare.startsWith("127."); // 127.0.0.0/8, and isIP proved it is a literal
  if (kind === 6) {
    if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
    // The IPv4-mapped loopback has two spellings for one address: dotted (`::ffff:127.0.0.1`)
    // and hex (`::ffff:7f00:1`). Recognising only the dotted form rejected a valid loopback
    // config in a way nobody would think to diagnose.
    const mapped = bare.match(/^(?:0*:)*:?ffff:(.+)$/);
    if (mapped?.[1]) {
      const tail = mapped[1];
      if (isIP(tail) === 4) return tail.startsWith("127.");
      const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (hex) return parseInt(hex[1]!, 16) >>> 8 === 0x7f;
    }
  }
  return false;
}

/**
 * Reject a host string that can smuggle authority into a URL.
 *
 * `@` is the dangerous one: `127.0.0.1@evil.example` parses as userinfo + host, so the client
 * connects to `evil.example` while the string looks local. `/`, `?`, `#` can move the path or
 * query. None of these belong in a hostname.
 */
export function assertPlainHost(host: string): void {
  if (/[@/?#\s]/.test(host)) {
    throw new Error(
      `Invalid daemon host ${JSON.stringify(host)}: a host cannot contain '@', '/', '?', '#' or ` +
        `whitespace. A host like "127.0.0.1@example.com" looks local but sends the request — and ` +
        `the token — to example.com.`,
    );
  }
}
