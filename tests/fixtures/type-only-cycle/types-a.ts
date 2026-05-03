// Type-only cycle: types-a ↔ types-b through `import type`. find_circular_deps
// SHOULD NOT report this once the type_only filter is active.
import type { TypeB } from "./types-b.js";
export type TypeA = { b: TypeB };
