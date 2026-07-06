// Shared indexing metadata used by index, status, and project-profile tools.

export const EXTRACTOR_VERSIONS = {
  stack_detector: "1.0.0",
  file_classifier: "1.0.0",
  hono: "2.0.0",
  nestjs: "1.0.0",
  nextjs: "1.0.0",
  express: "1.0.0",
  react: "2.0.0",  // Wave 1-4 + Tier 1-4: component/hook kinds, classifyReactKind, React class heritage - forces cache invalidation
  typescript: "3.0.0", // v3: extends/implements heritage, generics in signatures, enum members as constants, is_async flag, modifiers + accessor_kind in meta, namespace + ambient module declarations, anonymous default export synth, RangeError guard, AST-based import-graph branch with type_only flag + tsconfig paths resolution + find_circular_deps type-only filter (was v2.1: field_definition, CommonJS exports, object-literal methods, class_static_block, generator_function_declaration)
  javascript: "1.0.0", // independent JS version - bump for JS-only extractor changes (CJS, .jsx-specific) without forcing TS reindex
  python: "1.0.0",
  php: "2.0.0", // v2: extends/implements/uses_traits/modifiers/attributes on classes; typed properties + readonly + @var fallback on properties; promoted constructor params as synthetic field symbols; backed enum types; method-level modifiers + attributes; Codeception base classes (Unit/Cest/Cept) classify as test_suite - forces full reindex of PHP files
  astro: "1.0.0",
  kotlin: "1.0.0",
  monorepo: "1.0.0", // workspace resolver - bump forces reindex when workspace schema changes
} as const;
