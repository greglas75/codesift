<!-- zuvo-review -->
range: 8b6ee9b..fdf9b37
files: docs/adr/ADR-006-rust-core-napi.md, src/storage/embedding-store.ts, src/tools/astro-routes.ts, src/tools/graph-tools.ts, src/tools/index-tools/folder-indexer.ts, src/tools/index-tools/registry.ts, src/tools/index-tools/types.ts, src/tools/index-tools/worktree-seed-embeddings.ts, src/tools/index-tools/worktree-seed.ts, src/tools/route-tools/django.ts, src/tools/route-tools/express.ts, src/tools/route-tools/file-sources.ts, src/tools/route-tools/handler-discovery.ts, src/tools/route-tools/hono.ts, src/tools/route-tools/ktor.ts, src/tools/route-tools/laravel.ts, src/tools/route-tools/nest.ts, src/tools/route-tools/next-trace.ts, src/tools/route-tools/next.ts, src/tools/route-tools/python-decorators.ts, src/tools/route-tools/route-index.ts, src/tools/route-tools/spring-kotlin.ts, src/tools/route-tools/trace-route.ts, src/tools/route-tools/yii2.ts, src/types.ts, tests/tools/route-discovery-fixes.test.ts, tests/tools/route-tools-python.test.ts, tests/tools/route-tools.test.ts, tests/tools/worktree-seed-donor.test.ts, tests/tools/worktree-seed-embeddings.test.ts, tests/tools/worktree-seed.test.ts
adversarial: zuvo/proofs/rust-core-trace-route-adversarial.txt
tier: 3
verdict: APPROVE

# trace_route on a RouteIndex + worktree-seed donor/vector clone (fab8ed7a, another session)

`--multi` pass, 19 REVIEW BY lines. The range also holds fab8ed7a (worktree seed from the nearest indexed
commit, vector clone), committed by another session and unpushed; its findings were triaged here because
pushing this range pushes it. Real defects fixed in f15f3ed9: `git status --porcelain` parsed without `-z`
(quoted paths and `old -> new` renames matched no file), and the target embedding meta left behind when the
vector rename failed. Rejected after reading the code: id-rebase prefix without a boundary (it ends at `:`),
model mismatch between donor and target (one machine, one config), a nested worktree listed file by file
(git lists a nested checkout as one `dir/` entry, now skipped). trace_route findings were fixed in afb13d75
(one Python symbol read shared by Flask and FastAPI, Express comment).
