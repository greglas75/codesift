// DELIBERATE BOUNDARY VIOLATION SEED for AC4:
// apps/api should not import from apps/web. Workspace boundaries tool flags this.
import { Header } from "@org/web";
import type { User } from "@org/shared";

export function buildUsersRoute(): { user: User; header: typeof Header } {
  throw new Error("not implemented — fixture only");
}
