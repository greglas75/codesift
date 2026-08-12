/**
 * `@huggingface/transformers` is an **optionalDependency**, and both call sites already treat it
 * that way at runtime: each `await import(...)` sits in a `try`, is cast to `any`, and falls back
 * to "no local model" when it throws. So the package contributes zero type information — the only
 * thing a statically-resolvable specifier bought was a hard `tsc` failure when it is absent:
 *
 *   src/search/reranker.ts(21,39): error TS2307: Cannot find module '@huggingface/transformers'
 *   src/search/semantic.ts(501,39): error TS2307: Cannot find module '@huggingface/transformers'
 *
 * That turns an optional dependency into a mandatory build dependency, and the way it goes missing
 * is neither loud nor rare. Measured on burst-i9, 2026-08-12: `onnxruntime-node`'s postinstall
 * finds no `nvcc`, ASSUMES CUDA 12, and downloads a multi-hundred-MB GPU tarball from GitHub
 * releases; the download died with `Error: socket hang up`, the script crashed on an unhandled
 * error event, npm dropped the failed optional package **and `@huggingface/transformers` with it**
 * (238 packages -> 207) — and exited 0. Nothing before `tsc` said anything was wrong, three steps
 * later. Reproduced on npm 10.9.8 and 11.16.0 alike; `--ignore-scripts` restored the package on
 * both, which is what isolated the install script as the cause rather than the npm version.
 *
 * Widening the specifier to `string` stops `tsc` resolving it, so a missing optional package
 * degrades the feature exactly as designed instead of failing the build. Runtime behaviour is
 * unchanged: the import still throws when the package is absent, and the callers' existing
 * `catch` still turns that into "local embeddings unavailable".
 */
const SPECIFIER = "@huggingface/transformers";

/**
 * Import the optional transformers package. Throws when it is not installed — callers already
 * handle that, and turning it into `null` here would only move the crash to the first property
 * access.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function importTransformers(): Promise<any> {
  // Deliberately typed `string`, not the literal: a literal type is resolvable and brings TS2307
  // back. This line is the fix — do not "simplify" it to `import(SPECIFIER)`.
  const spec: string = SPECIFIER;
  return await import(spec);
}
