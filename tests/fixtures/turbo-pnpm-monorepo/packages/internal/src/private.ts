export function privateOnly(): string {
  return "should not be in workspaces (excluded via pnpm-workspace negation)";
}
