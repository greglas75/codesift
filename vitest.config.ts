import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
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
            "tests/cli/**/*.test.ts",
            "tests/formatters/**/*.test.ts",
            "tests/lsp/**/*.test.ts",
            "tests/storage/**/*.test.ts",
            "tests/search/**/*.test.ts",
            "tests/tools/**/*.test.ts",
            "tests/integration/**/*.test.ts",
            "tests/retrieval/**/*.test.ts",
          ],
          environment: "node",
          pool: "vmForks",
          poolOptions: {
            vmForks: { singleFork: true },
          },
        },
      },
    ],
  },
});
