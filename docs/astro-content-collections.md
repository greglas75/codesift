# Astro content collection analysis

The `astro_content_collections` tool keeps its public handler and result types in
`src/tools/astro-content-collections.ts`. Implementation details are split by responsibility:

- `discovery.ts` locates Astro v5 and legacy configs, then extracts collection and loader definitions.
- `schema.ts` reads Zod field metadata and parses JSON, YAML, and Markdown frontmatter entries.
- `diagnostics.ts` resolves loader files, enforces project-root containment, validates required fields,
  builds reference edges, and assembles collection summaries.
- `types.ts` contains the public result contracts and the internal contracts shared by those modules.

Loader paths are checked through their physical paths to prevent traversal outside the indexed project,
while matching and reporting retain the configured logical path. Glob patterns are applied relative to
their explicit `base`; base-less patterns use a static project-relative prefix and skip `.git`, `.astro`,
`dist`, and `node_modules` when a root traversal is unavoidable.

File loaders support a single object, an array of objects, and id-keyed object maps. Entry counts represent
successfully parsed entries rather than source files. Invalid JSON/YAML, unreadable entries, missing
frontmatter, unavailable parsers, and config parse failures are reported explicitly instead of being
silently treated as empty collections.
