import { HAS_NODE_SQLITE } from "./node-sqlite.js";

/**
 * Whether the SQLite the store uses can write through an overlay (`overlayWritesSupported`). Its own
 * module because loading it resolves (and memoises) the SQLite constructor from the ambient
 * environment; only the overlay suites, which never switch backends, import it.
 */
export const HAS_OVERLAY_WRITES = HAS_NODE_SQLITE && await (async () => {
  const { loadSqliteCtor } = await import("../../src/storage/sqlite/runtime.js");
  const { overlayWritesSupported } = await import("../../src/storage/sqlite/overlay.js");
  const Ctor = await loadSqliteCtor();
  return Ctor !== null && overlayWritesSupported(Ctor);
})();
