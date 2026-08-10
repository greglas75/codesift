import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";


// Force @mrleebo/prisma-ast to resolve to its ESM build instead of the CJS
// dispatcher; the CJS build does a runtime `require("chevrotain")` which
// fails because chevrotain ships as pure ESM (type: module).
const prismaAstEsm = fileURLToPath(
  new URL("./node_modules/@mrleebo/prisma-ast/dist/prisma-ast.esm.js", import.meta.url),
);

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node
  .split(".")
  .map((part) => Number.parseInt(part, 10));
const hasNodeSqlite = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);
const sqliteOnlyTests = hasNodeSqlite
  ? []
  : [
      "tests/cli/prune-rescue-collision.test.ts",
      "tests/storage/index-backend-migration.test.ts",
      "tests/storage/index-cache-memory-budget.test.ts",
      "tests/storage/index-storage-errors.test.ts",
      "tests/storage/index-summary.test.ts",
      "tests/storage/sqlite-*.test.ts",
    ];

export default defineConfig({
  resolve: {
    alias: {
      "@mrleebo/prisma-ast": prismaAstEsm,
    },
  },
  test: {
    globals: true,
    testTimeout: 15000,
    // Per-file CodeSift data dir — see tests/setup-data-dir.ts for why the
    // suite cannot share one (process-global env + a whole-file read-modify-write
    // registry, raced both within a process and across workers).
    setupFiles: ["./tests/setup-data-dir.ts"],
    // Write worker console output straight to the terminal instead of shipping
    // every line to the main process over RPC. Several suites run `git` inside
    // throwaway temp dirs, so a run emits hundreds of `fatal: not a git
    // repository` lines; when one lands as its worker is tearing down, vitest
    // fails the whole run with `EnvironmentTeardownError: Closing rpc while
    // "onUserConsoleLog" was pending` — every test passing, exit code 1. The
    // interception is what races, and nothing here needs it.
    disableConsoleIntercept: true,
    // Disable local embedding default in tests. The Local provider lazy-loads
    // onnxruntime-node, which crashes on Float32Array prototype checks inside
    // vitest's VM context (`A float32 tensor's data must be type of function
    // Float32Array`). Tests that explicitly want local embeddings (the E2E
    // suite in tests/search/semantic.test.ts) override this with their own
    // `process.env` setup.
    env: {
      CODESIFT_DISABLE_LOCAL_EMBEDDINGS: "true",
    },
    server: {
      deps: {
        // Ensure chevrotain + prisma-ast ESM are transformed by Vite so the
        // alias above takes effect inside vmForks/forks pools.
        inline: [/chevrotain/, /@mrleebo\/prisma-ast/],
      },
    },
    coverage: {
      provider: "v8",
      thresholds: {
        statements: 70,
        branches: 55,
        functions: 65,
      },
    },
    projects: [
      {
        // Parser tests — need WASM, run in Node environment
        extends: true,
        test: {
          name: "parser",
          include: ["tests/parser/**/*.test.ts"],
          environment: "node",
          pool: "forks",
          testTimeout: 30000, // WASM init can be slow
        },
      },
      {
        // All other tests
        extends: true,
        test: {
          name: "core",
          include: [
            "tests/instructions*.test.ts",
            "tests/rules-content.test.ts",
            "tests/cli/**/*.test.ts",
            "tests/formatters/**/*.test.ts",
            "tests/lsp/**/*.test.ts",
            "tests/scripts/**/*.test.ts",
            "tests/server-helpers/**/*.test.ts",
            "tests/server/**/*.test.ts",
            "tests/storage/**/*.test.ts",
            "tests/search/**/*.test.ts",
            "tests/tools/**/*.test.ts",
            "tests/integration/**/*.test.ts",
            "tests/retrieval/**/*.test.ts",
            "tests/utils/**/*.test.ts",
          ],
          // Node 20 is a supported JSON-backend runtime, but `node:sqlite`
          // itself was only added in Node 22.5. Keep the rest of the suite on
          // Node 20 and omit only contracts that exercise SQLite directly.
          exclude: sqliteOnlyTests,
          environment: "node",
          // `forks`, not `vmForks`. Same isolation for this suite, about half
          // the wall clock (~80s -> ~45s), and the prisma-ast/chevrotain tests
          // that `vmForks` originally arrived with pass under it. Note this is
          // a speed choice, NOT the flakiness fix — see below.
          pool: "forks",
          // A worker per file, deliberately: `singleFork: true` was the single
          // biggest contributor to this suite's flakiness, not a defence against
          // it. Its comment used to claim these suites "share process-level
          // caches and mutate env" so they must share one process — but sharing
          // a process is precisely what makes mutating env unsafe. vitest still
          // runs test FILES concurrently inside one fork, and 47 of these files
          // point `process.env.CODESIFT_DATA_DIR` at their own tmpdir in
          // `beforeAll` and `delete` it in `afterAll`. Whoever wrote the global
          // last owned it: file A indexed fixtures into /tmp/A, file B
          // overwrote the variable with /tmp/B, and A's assertions looked up A's
          // repo in B's registry — `Repository "local/php-yii-console" not
          // found`, a different victim every run, all green in isolation.
          //
          // Measured, whole suite, same machine:
          //   vmForks + singleFork                       2/5 green
          //   forks   + singleFork                       8/9 green (timing shift only)
          //   forks   + singleFork + fileParallelism:off 2/2 green but ~270s
          //   forks   + worker-per-file + per-file dir   8/9, then green after
          //                                              disableConsoleIntercept
          // Serialising files also works and for the same reason, but costs 6x
          // wall clock. Separate processes get the same guarantee for free.
          //
          // The other half of the fix is `tests/setup-data-dir.ts`: separate
          // processes alone would still share ONE registry.json, and
          // `registerRepo` is a whole-file read-modify-write, so workers would
          // clobber each other's repos across process boundaries instead of
          // within one. A per-file data dir closes both.
          singleFork: false,
          fileParallelism: true,
          server: {
            deps: {
              // chevrotain ships ESM in a CJS wrapper; inline so Vite transforms
              // it. The /.*/ regex for prisma-ast forces Vite to resolve via
              // its `module` field (ESM build) instead of the CJS dispatcher.
              inline: [/chevrotain/, /@mrleebo\/prisma-ast/],
            },
          },
        },
      },
    ],
  },
});
