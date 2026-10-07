// npm runs this on every install, including `npm ci` in a git clone — where dist/ does not exist
// until the first build. The old shell line survived that through `|| true`; a bare
// `node ./dist/postinstall.js` failed the install instead. Configuration is a published-package
// concern, so a clone without a build has nothing to configure and exits 0.
import { existsSync } from "node:fs";

const entry = new URL("./dist/postinstall.js", import.meta.url);
if (existsSync(entry)) await import(entry.href);
