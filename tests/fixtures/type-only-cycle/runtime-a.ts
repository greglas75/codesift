// Runtime cycle: a ↔ b. find_circular_deps SHOULD report this.
import { B } from "./runtime-b.js";
export const A = () => B();
