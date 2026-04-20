export function Page(name: string): string {
  // triggers builtin-collision test: project symbol named `map`
  const parts = name.split("").map((c) => c.toUpperCase());
  return `<h1>Hello, ${parts.join("")}</h1>`;
}

// Locally-defined `map` function whose file_rank is low — should be
// filtered by the builtin blocklist.
export function map<T, U>(xs: T[], f: (x: T) => U): U[] {
  return xs.map(f);
}
