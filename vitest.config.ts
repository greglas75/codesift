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
            "tests/server-helpers/**/*.test.ts",
            "tests/storage/**/*.test.ts",
            "tests/search/**/*.test.ts",
            "tests/tools/**/*.test.ts",
            "tests/integration/**/*.test.ts",
            "tests/retrieval/**/*.test.ts",
            "tests/utils/**/*.test.ts",
          ],
          environment: "node",
          pool: "vmForks",
          poolOptions: {
            vmForks: { singleFork: true },
          },
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
