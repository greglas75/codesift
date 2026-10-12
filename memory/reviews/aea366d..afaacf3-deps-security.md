<!-- zuvo-review -->
range: aea366d..afaacf3
files: package-lock.json
adversarial: zuvo/proofs/2d4779c-deps-security.txt
tier: 2
verdict: APPROVE

# Lockfile: patched versions for the Dependabot alerts

Lockfile only, with every version inside its parent's declared range: @modelcontextprotocol/sdk 1.32.1,
proxy-addr 2.0.8, ip-address 10.7.4, fast-uri 3.1.8, source-map-js 1.2.2, sharp 0.35.5. sprintf-js has
no patched release.

The cross-model review (which also covered 1cb58fa and aea366d from the other session) raised five
points about the lockfile; all were rejected:
- the SDK bump is a minor within ^1, not a major;
- sharp's platform packages move together by design;
- fast-uri is a patch;
- every version change follows from these updates.

Verified: full suite 6731 passed (the one failure, sqlite-compat-parity, is a 15 s timeout under the
full run that predates this change; 5/5 alone); lint clean; stdio handshake plus tools/call and the
HTTP daemon verified on the new SDK.
