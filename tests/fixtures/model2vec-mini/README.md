# model2vec-mini fixture

Minimal Model2Vec ("static" embedding) fixture for `StaticEmbeddingProvider`.

**No binaries are committed here.** The `model.safetensors` and `tokenizer.json`
files are generated programmatically per-test by helpers in
`tests/search/static-embedding-provider.test.ts`, written to a tmpdir, and the
mocked `ensureModelFile` is pointed at those tmp paths. This avoids checking
binary weights into git while still exercising the real parse → tokenize →
mean-pool → L2-normalize path with zero network.

Fixture spec (see the test file's `fixtureSafetensorsBytes` / `fixtureTokenizerJson`):

- Matrix: 3 rows × 4 cols (F32, tensor name `embeddings`)
  - row 0 = `[1,0,0,0]` → token `hello`
  - row 1 = `[0,2,0,0]` → token `world`
  - row 2 = `[0,0,0,0]` → token `[UNK]`
- Tokenizer: nested WordPiece shape `{ model: { vocab: { hello:0, world:1, "[UNK]":2 } } }`
