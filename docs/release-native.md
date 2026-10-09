# Releasing the native core (`@codesift/core-*`)

The Rust core (ADR-006) ships as one npm package per platform, installed by `codesift-mcp` as
optional dependencies:

| package | runner in `release.yml` |
|---|---|
| `@codesift/core-darwin-arm64` | macos-14 |
| `@codesift/core-darwin-x64` | macos-14, cross-compiled (`--target x86_64-apple-darwin`) |
| `@codesift/core-linux-x64-gnu` | ubuntu-22.04 (older glibc → loads on more distributions) |
| `@codesift/core-linux-arm64-gnu` | ubuntu-22.04-arm |
| `@codesift/core-win32-x64-msvc` | windows-latest |

Templates live in `npm/<tag>/`. Nothing about them is committed per release: the release workflow
copies each built `.node` in, stamps the main package's version, publishes, and only then writes
`optionalDependencies` into the main `package.json` — for the platforms that actually published.
A platform whose build or publish failed is left out, and its users get the TypeScript path, as before
the core existed. The step summary lists what was published and what was skipped.

## One-time bootstrap (owner)

npm only lets a trusted publisher be configured on a package that already exists, and the release
workflow publishes through OIDC. So, once:

1. **Create the npm organization `codesift`** (npmjs.com → your avatar → Add Organization; the free
   plan is enough for public packages).
2. **Publish the placeholders** — a 0.0.0 of each package, no binary:
   ```bash
   npm login
   node scripts/bootstrap-native-packages.mjs --dry-run   # check first
   node scripts/bootstrap-native-packages.mjs
   ```
3. **Give each package a trusted publisher**: npmjs.com → the package → Settings → Trusted Publisher →
   GitHub Actions, owner `greglas75`, repository `codesift`, workflow `release.yml`. Five times.

From the next `npm version … && git push --follow-tags` on, the binaries publish with the release.
Nobody ever installs 0.0.0: `codesift-mcp` pins its optional dependencies to its own version.

## Verifying a release

```bash
npm view codesift-mcp@<version> optionalDependencies     # the platforms that made it
npx -y codesift-mcp@<version> --version                   # installs and runs on this machine
curl -s 127.0.0.1:7077/health | jq .native                # a daemon on it reports "loaded": true
```

A machine without a matching package (or with `CODESIFT_NATIVE=0`) reports `"loaded": false` and a
reason, and works exactly as before — the core is optional by design.
