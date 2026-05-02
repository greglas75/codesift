// DELIBERATE BOUNDARY VIOLATION SEED for AC4:
// apps/api should not import from apps/web. Workspace boundaries tool flags this.
// Subpath import resolves via the workspace-alias resolver to apps/web/src/components/Header.tsx.
import { Header } from "@org/web/components/Header";
import type { User } from "@org/shared";

export function buildUsersRoute(): { user: User; header: typeof Header } {
  throw new Error("not implemented — fixture only");
}
