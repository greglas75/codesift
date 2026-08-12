/**
 * Post-install diagnostic for the one feature that can disappear during a SUCCESSFUL install.
 *
 * `@huggingface/transformers` is an optionalDependency and pulls in `onnxruntime-node`, whose
 * install script — only on linux/x64 — looks for `nvcc`, ASSUMES CUDA 12 when it finds none, and
 * downloads a multi-hundred-MB GPU build from GitHub releases. Measured on burst-i9 2026-08-12 the
 * download died with `Error: socket hang up`; npm then dropped the failed optional package AND
 * `@huggingface/transformers` with it (238 installed packages -> 207) and **exited 0**.
 *
 * The user is left with a clean install, no GPU, no local embeddings, and nothing pointing at the
 * cause until a semantic query fails much later. This turns that into one sentence and one command,
 * at the moment it happens.
 *
 * This file lives in `src/` rather than `scripts/` on purpose: `package.json#files` publishes
 * `dist` and not `scripts`, so a check placed there would never reach the users who need it.
 */
import { importTransformers } from "./search/optional-transformers.js";

export interface InstallCheckEnv {
  platform: string;
  arch: string;
  transformersResolved: boolean;
}

/**
 * The notice to print, or null when there is nothing worth saying.
 *
 * Deliberately narrow. It fires only where the CUDA download is actually attempted (linux/x64 — the
 * guard in onnxruntime's own script) and only when the package is genuinely absent. Warning a macOS
 * user, where the download is skipped by construction, would teach everyone to ignore the message.
 */
export function embeddingInstallNotice(env: InstallCheckEnv): string | null {
  if (env.transformersResolved) return null;
  if (env.platform !== "linux" || env.arch !== "x64") return null;
  return [
    "",
    "  ⚠️  CodeSift installed, but local embeddings are NOT available.",
    "",
    "  Cause: onnxruntime-node's install step downloads a CUDA/GPU build on linux/x64 even when",
    "  there is no GPU. When that download fails, npm drops it together with",
    "  @huggingface/transformers — and still reports the install as successful.",
    "",
    "  Fix (skips the GPU download, keeps everything else):",
    "    npm install -g codesift-mcp --onnxruntime-node-install-cuda=skip",
    "",
    "  Or use a remote provider: set CODESIFT_VOYAGE_API_KEY or CODESIFT_OPENAI_API_KEY.",
    "  Search, symbols and analysis are unaffected — only semantic search needs this.",
    "",
  ].join("\n");
}

export async function transformersResolvable(): Promise<boolean> {
  try {
    await importTransformers();
    return true;
  } catch {
    return false;
  }
}

export async function runInstallCheck(): Promise<void> {
  const notice = embeddingInstallNotice({
    platform: process.platform,
    arch: process.arch,
    transformersResolved: await transformersResolvable(),
  });
  if (notice) console.error(notice);
}

// Run only when invoked directly by the postinstall hook — importing this module (tests) must print
// nothing. A diagnostic that can fail `npm install` is worse than the problem it reports, so every
// path here ends at exit 0.
if (process.argv[1]?.endsWith("install-check.js")) {
  runInstallCheck()
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
