# Implementation Plan: Python Phase 2-4

**Spec:** `docs/specs/2026-04-11-python-support-audit-and-brainstorm.md` (Phases 2-4)
**planning_mode:** inline (spec as reference)
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-11
**Tasks:** 10
**Estimated complexity:** 6 standard + 4 complex

## Architecture Summary

Six features across three phases, each in its own module:
- **Phase 2:** Route tracing (extend route-tools.ts), Anti-patterns (extend pattern-tools.ts), Model graph (new model-tools.ts)
- **Phase 3:** Pytest fixtures (new pytest-tools.ts), Framework wiring (new wiring-tools.ts)
- **Phase 4:** Ruff integration (new ruff-tools.ts), pyproject parsing (new pyproject-tools.ts)

All tools are hidden/discoverable via `discover_tools` + `describe_tools`.

## Task Breakdown

### Task 1: Python anti-patterns — 17 built-in patterns
**Files:** `src/tools/pattern-tools.ts`, `tests/tools/pattern-tools-python.test.ts`
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Test each pattern against a known-positive Python snippet. Assert match count > 0 for positive cases and 0 for negative cases.
- [ ] GREEN: Add 17 Python patterns to BUILTIN_PATTERNS: `mutable-default`, `bare-except`, `broad-except`, `global-keyword`, `star-import`, `print-debug-py`, `eval-exec`, `shell-true`, `pickle-load`, `yaml-unsafe`, `open-no-with`, `string-concat-loop`, `datetime-naive`, `shadow-builtin`, `n-plus-one-django`, `late-binding`, `assert-tuple`.
- [ ] Verify: `npx vitest run tests/tools/pattern-tools-python.test.ts`
- [ ] Commit: `add 17 Python anti-pattern detectors to search_patterns`

### Task 2: Flask/FastAPI route tracing
**Files:** `src/tools/route-tools.ts`, `tests/tools/route-tools-python.test.ts`
**Complexity:** complex
**Dependencies:** none

- [ ] RED: Test `findFlaskHandlers` and `findFastAPIHandlers` with mock indexes containing decorator-based routes. Assert handler resolution, method extraction, path matching.
- [ ] GREEN: Add `findFlaskHandlers(index, searchPath)` and `findFastAPIHandlers(index, searchPath)` — parse `@app.route()`, `@bp.route()`, `@app.get/post/put/delete()`, `@router.get()` decorators from symbol source. Extract route paths, HTTP methods, Blueprint/APIRouter prefixes. Wire into `traceRoute` dispatcher.
- [ ] Verify: `npx vitest run tests/tools/route-tools-python.test.ts`
- [ ] Commit: `add Flask and FastAPI route tracing to trace_route`

### Task 3: Django URL route tracing
**Files:** `src/tools/route-tools.ts`, `tests/tools/route-tools-python.test.ts` (extend)
**Complexity:** complex
**Dependencies:** Task 2

- [ ] RED: Test `findDjangoHandlers` with mock index containing urls.py with `urlpatterns`, `path()`, `include()`. Assert resolution of URL → view function, include chain following.
- [ ] GREEN: Add `findDjangoHandlers(index, searchPath)` — read urls.py files, parse `urlpatterns` list, follow `include()` chains, resolve view references to symbols. Extract path converters (`<int:pk>`). Wire into dispatcher with `framework: "django"`.
- [ ] Verify: `npx vitest run tests/tools/route-tools-python.test.ts`
- [ ] Commit: `add Django URL pattern tracing to trace_route`

### Task 4: ORM model graph — Django + SQLAlchemy
**Files:** `src/tools/model-tools.ts` (new), `tests/tools/model-tools.test.ts` (new)
**Complexity:** complex
**Dependencies:** none

- [ ] RED: Test `getModelGraph` with mock index containing Django models (ForeignKey, ManyToManyField) and SQLAlchemy models (relationship, Column). Assert extracted nodes, edges, relationship types.
- [ ] GREEN: Create `src/tools/model-tools.ts` with `getModelGraph(repo, options)`. Parse model class source for field declarations. Detect Django field types (ForeignKey, OneToOneField, ManyToManyField) and SQLAlchemy relationship(). Build graph of model → model edges with relationship type labels. Output as structured JSON or mermaid diagram. Register as hidden tool via `describe_tools(reveal=true)`.
- [ ] Verify: `npx vitest run tests/tools/model-tools.test.ts`
- [ ] Commit: `add get_model_graph tool for Django and SQLAlchemy ORM relationship extraction`

### Task 5: pytest fixture graph
**Files:** `src/tools/pytest-tools.ts` (new), `tests/tools/pytest-tools.test.ts` (new)
**Complexity:** complex
**Dependencies:** none

- [ ] RED: Test `getTestFixtures` with mock index containing conftest.py hierarchy with fixtures of varying scope. Assert fixture discovery, dependency graph, scope detection, autouse.
- [ ] GREEN: Create `src/tools/pytest-tools.ts` with `getTestFixtures(repo, options)`. Scan conftest.py files (project root → test dir → test subdir). Extract `@pytest.fixture` definitions using existing extractor's `test_hook` kind. Parse fixture parameters for dependencies (fixture A uses fixture B). Detect scope from decorator args (`scope="session"`). Detect `autouse=True`. Build dependency graph. Register as hidden tool.
- [ ] Verify: `npx vitest run tests/tools/pytest-tools.test.ts`
- [ ] Commit: `add get_test_fixtures tool for pytest fixture dependency graph`

### Task 6: Framework wiring discovery
**Files:** `src/tools/wiring-tools.ts` (new), `tests/tools/wiring-tools.test.ts` (new)
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Test `findFrameworkWiring` against mock index with Django signals, Celery tasks, middleware, management commands. Assert each wiring type discovered.
- [ ] GREEN: Create `src/tools/wiring-tools.ts` with `findFrameworkWiring(repo, options)`. Detect via regex/source scan: Django `@receiver(signal, sender=)`, `Signal.connect()`, Celery `@app.task`/`@shared_task`, `delay()`/`apply_async()` call sites, Django MIDDLEWARE from settings.py, `BaseCommand` subclasses in `management/commands/`, Flask `init_app()`, FastAPI `@app.on_event()`. Register as hidden tool.
- [ ] Verify: `npx vitest run tests/tools/wiring-tools.test.ts`
- [ ] Commit: `add find_framework_wiring tool for Django signals Celery tasks and middleware`

### Task 7: Ruff integration
**Files:** `src/tools/ruff-tools.ts` (new), `tests/tools/ruff-tools.test.ts` (new)
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Test `runRuff` with a small Python file containing known violations. Assert structured output with file, line, rule, message. Test graceful handling when ruff not installed.
- [ ] GREEN: Create `src/tools/ruff-tools.ts` with `runRuff(repo, options)`. Shell out to `ruff check --output-format json` with configurable categories (B, PERF, SIM, UP, PT, S, DJ, ASYNC, RET, ARG). Parse JSON output. Correlate findings with CodeSift symbol graph (find containing_symbol for each finding). Register as hidden tool.
- [ ] Verify: `npx vitest run tests/tools/ruff-tools.test.ts`
- [ ] Commit: `add run_ruff tool with symbol graph correlation`

### Task 8: pyproject.toml parsing
**Files:** `src/tools/pyproject-tools.ts` (new), `tests/tools/pyproject-tools.test.ts` (new)
**Complexity:** standard
**Dependencies:** none

- [ ] RED: Test `parsePyproject` with sample pyproject.toml content. Assert extraction of dependencies, Python version, build system, configured tools, entry points.
- [ ] GREEN: Create `src/tools/pyproject-tools.ts` with `parsePyproject(repo)`. Read `pyproject.toml` from repo root. Parse TOML (use a lightweight parser or regex for key sections). Extract: `[project]` deps + optional-deps, `requires-python`, `[build-system]`, `[tool.ruff]`, `[tool.pytest]`, `[tool.mypy]`, entry points. Register as hidden tool.
- [ ] Verify: `npx vitest run tests/tools/pyproject-tools.test.ts`
- [ ] Commit: `add parse_pyproject tool for Python project config analysis`

### Task 9: Register all new tools
**Files:** `src/register-tools.ts`
**Complexity:** standard
**Dependencies:** Tasks 4-8

- [ ] RED: n/a (registration task)
- [ ] GREEN: Import and register all new tools as hidden (disabled) in register-tools.ts following the existing pattern. Tools: `get_model_graph`, `get_test_fixtures`, `find_framework_wiring`, `run_ruff`, `parse_pyproject`. Each with proper schema, description, and `tool.disable()` call.
- [ ] Verify: `npx vitest run tests/tools/` (all tool tests pass)
- [ ] Commit: `register Python Phase 2-4 tools as discoverable hidden tools`

### Task 10: Update docs + integration test
**Files:** `CLAUDE.md`, `src/instructions.ts` (if needed), `tests/integration/python-phase2-4.test.ts`
**Complexity:** standard
**Dependencies:** Tasks 1-9

- [ ] RED: Integration test: index a synthetic Django/Flask project, run trace_route, search_patterns, get_model_graph, get_test_fixtures. Assert non-empty results.
- [ ] GREEN: Update CLAUDE.md tool count, architecture section. Update instructions.ts if ALWAYS/NEVER rules changed. Create integration test with fixture project.
- [ ] Verify: `npx vitest run tests/integration/python-phase2-4.test.ts`
- [ ] Commit: `document Python Phase 2-4 tools and add integration test`
