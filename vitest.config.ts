import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Force @mrleebo/prisma-ast to resolve to its ESM build instead of the CJS
// dispatcher; the CJS build does a runtime `require("chevrotain")` which
// fails because chevrotain ships as pure ESM (type: module).
const prismaAstEsm = fileURLToPath(
  new URL("./node_modules/@mrleebo/prisma-ast/dist/prisma-ast.esm.js", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      "@mrleebo/prisma-ast": prismaAstEsm,
    },
  },
  test: {
    globals: true,
    testTimeout: 15000,
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
          environment: "node",
          // `forks`, NOT `vmForks`. Measured on this suite: vmForks produced a
          // green run only 2 times in 5, failing 1-3 files per run, and never
          // the same files — ast-query, astro-pipeline, report-react,
          // taint-tools, constant-resolution, workspace-tools and others took
          // turns, each passing 10/10 in isolation. Every failure was an EMPTY
          // result ("expected [] to have a length of 1", "Repository ... not
          // found"), i.e. state that should have been there was not.
          // Switching the pool made it 8 of 8 green and roughly halved the wall
          // clock (~80s -> ~45s). The precise mechanism inside the VM context
          // is not identified; what is established is that it is the pool, not
          // the tests — the same files pass consistently under `forks`.
          // vmForks originally came in with the prisma-ast/chevrotain alias
          // work; those tests (15) pass under `forks` too.
          pool: "forks",
          // Vitest 4 removed `test.poolOptions` — the former per-pool settings
          // are top-level now. Left as-is, `singleFork` would be silently
          // ignored, and it is not decoration: these suites share process-level
          // caches and mutate env, so running them across forks reintroduces
          // exactly the cross-test interference singleFork was added to stop.
          singleFork: true,
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
