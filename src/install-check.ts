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
import { importTransformers, TRANSFORMERS_SPECIFIER } from "./search/optional-transformers.js";

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

/**
 * The install command that would have worked in the first place.
 *
 * Our postinstall runs AFTER the dependency's, which is the whole opportunity here: by then npm has
 * already attempted the CUDA download, failed, and removed the package — and we are a normal
 * process that can simply ask for it again with the flag set. npm gives a package no way to
 * configure a transitive dependency's install script up front (each script is spawned from npm's
 * own environment, and ours runs too late to change it), so repairing afterwards is the only lever
 * that exists from inside the package.
 */
export function repairArgs(version: string): string[] {
  return [
    "install",
    "--no-save",
    "--no-audit",
    "--no-fund",
    // The one flag that matters: it is what stops the GPU download from being attempted again, and
    // therefore what makes this attempt different from the one that just failed.
    "--onnxruntime-node-install-cuda=skip",
    `@huggingface/transformers@${version}`,
  ];
}

export interface RepairDeps {
  run: (args: string[], cwd: string) => Promise<number>;
  resolved: () => Promise<boolean>;
  packageRoot: string;
  version: string;
}

/**
 * Try once, verify, and report honestly. Returns true only when the package is importable
 * afterwards — a zero exit code from npm is not proof, because npm exits 0 when it drops a failed
 * optional package, which is the exact behaviour that created this situation.
 */
export async function repairLocalEmbeddings(deps: RepairDeps): Promise<boolean> {
  try {
    await deps.run(repairArgs(deps.version), deps.packageRoot);
  } catch {
    return false;
  }
  return deps.resolved();
}

export async function runInstallCheck(): Promise<void> {
  const env = {
    platform: process.platform,
    arch: process.arch,
    transformersResolved: await transformersResolvable(),
  };
  if (embeddingInstallNotice(env) === null) return;

  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync } = await import("node:fs");
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url))); // dist/ -> package root

  let version = "*";
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
      optionalDependencies?: Record<string, string>;
    };
    // Stay inside the range we declare, so the repair cannot quietly install a different major
    // than the one this build was tested against.
    version = pkg.optionalDependencies?.["@huggingface/transformers"] ?? "*";
  } catch {
    /* fall back to "*" — a repair with a loose range still beats no local embeddings */
  }

  console.error(
    "\n  CodeSift: local embeddings were dropped during install (onnxruntime's GPU download)."
    + "\n  Retrying without it — this takes a moment and needs no action from you.\n",
  );

  const { spawn } = await import("node:child_process");

  /**
   * Verify in a FRESH process, not with `transformersResolvable()`.
   *
   * Node's ESM loader caches a failed resolution for the whole process lifetime, and this check
   * already imported the specifier once — before the repair — to decide whether to run at all. So
   * an in-process re-check returns false no matter what the repair did. Caught end-to-end on
   * burst-i9 2026-08-12: the package was restored (present on disk, no CUDA download) and the
   * script still told the user the repair had failed. Unit tests could not see this; they inject
   * `resolved`, which is exactly the seam the loader cache hides behind.
   */
  const resolvedInFreshProcess = (): Promise<boolean> =>
    new Promise((resolve) => {
      // The specifier travels in the environment rather than inside the probe source: written
      // inline it would be a literal `import("<pkg>")` in this file, which is exactly what the
      // guard test forbids — and rightly so, since a reader (and a grep) cannot tell at a glance
      // that this particular one is inert because it lives in a string.
      const probe = spawn(
        process.execPath,
        ["--input-type=module", "-e", "import(process.env.CS_PROBE_SPEC).then(()=>process.exit(0),()=>process.exit(1))"],
        { cwd: packageRoot, stdio: "ignore", env: { ...process.env, CS_PROBE_SPEC: TRANSFORMERS_SPECIFIER } },
      );
      probe.on("error", () => resolve(false));
      probe.on("close", (code) => resolve(code === 0));
    });

  const repaired = await repairLocalEmbeddings({
    packageRoot,
    version,
    resolved: resolvedInFreshProcess,
    run: (args, cwd) =>
      new Promise<number>((resolve, reject) => {
        const child = spawn("npm", args, { cwd, stdio: "ignore" });
        // Bounded: a hung download must not hold `npm install -g` open indefinitely. Five minutes
        // is generous for one package and still finite.
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timeout")); }, 300_000);
        child.on("error", (err) => { clearTimeout(timer); reject(err); });
        child.on("close", (code) => { clearTimeout(timer); resolve(code ?? 1); });
      }),
  });

  if (repaired) {
    console.error("  ✅ CodeSift: local embeddings restored.\n");
    return;
  }
  // Only now is the manual instruction warranted — and it is the same command, so the user is not
  // being asked to guess.
  console.error(embeddingInstallNotice(env));
}

// Run only when invoked directly by the postinstall hook — importing this module (tests) must print
// nothing. A diagnostic that can fail `npm install` is worse than the problem it reports, so every
// path here ends at exit 0.
if (process.argv[1]?.endsWith("install-check.js")) {
  runInstallCheck()
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
