# @codesift/core-win32-x64-msvc

The native core of [codesift-mcp](https://www.npmjs.com/package/codesift-mcp) for Windows x64: storage reads, BM25 search and tree-sitter symbol extraction compiled from Rust (ADR-006).

Installed automatically as an optional dependency of `codesift-mcp` on matching platforms. codesift-mcp works without it — it falls back to its TypeScript implementation — so a missing or unloadable binary is never an error.
