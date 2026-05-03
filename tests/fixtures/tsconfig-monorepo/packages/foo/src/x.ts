// Importer test file. The resolver should find tsconfig at packages/foo/tsconfig.json
// (nearest), follow extends to ../../tsconfig.base.json, and resolve @shared/utils
// to packages/shared/utils.ts.
export const X = 1;
