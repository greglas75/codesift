# Python Support: Audit, Competitive Analysis & Tool Brainstorm

**Date:** 2026-04-11  
**Status:** Research complete, awaiting review

---

## Part 1: Current Python Support Audit

### 1.1 Python Extractor (`src/parser/extractors/python.ts`)

**What works:**

| Feature | Status | Notes |
|---------|--------|-------|
| Functions | OK | Module-level functions extracted as `function` |
| Methods | OK | Class-level functions as `method` |
| Classes | OK | `class_definition` nodes |
| Decorators | OK | `decorated_definition` node handled, decorators collected |
| Docstrings | OK | First `expression_statement` string in body |
| Signatures | OK | `(params) -> ReturnType` captured |
| pytest fixtures | OK | `@pytest.fixture` / `@fixture` -> `test_hook` |
| test functions | OK | `test_*` -> `test_case` |
| unittest classes | OK | `TestCase` inheritance -> `test_suite` |
| Parent-child | OK | Methods linked to parent class via `parentId` |

**What's missing:**

| Feature | Impact | Notes |
|---------|--------|-------|
| `async def` | MEDIUM | Not distinguished from regular `def` — no `async_function` kind |
| Generators (`yield`) | LOW | Not classified separately |
| `@dataclass` | HIGH | Treated as plain class; fields not extracted as symbols |
| `@property` / `@classmethod` / `@staticmethod` | MEDIUM | Detected as decorated functions but not given special kinds |
| `__dunder__` methods | MEDIUM | Extracted as plain `method`, not tagged as protocol/magic |
| `Protocol` / `ABC` | MEDIUM | No detection of abstract classes or protocol compliance |
| `__all__` exports | HIGH | Not parsed — affects reference tracking |
| `__slots__` | LOW | Not detected |
| Metaclasses | LOW | Not handled |
| Superclass tracking | MEDIUM | Only checked for `TestCase`, not stored generally |
| Type hint annotations | LOW | Captured in signature string but not semantically parsed |
| Nested classes | LOW | Not explicitly handled (walk doesn't recurse into nested classes outside body) |
| Module-level variables | MEDIUM | Constants/config at module level not extracted |

### 1.2 Import Graph (`src/utils/import-graph.ts`)

**CRITICAL GAP** — Zero Python import support.

Current patterns match only JS/TS:
```
import ... from '...'  // ES modules
import('...')           // Dynamic import  
require('...')          // CommonJS
```

Missing Python patterns:
- `import module`
- `from module import name`
- `from . import sibling` (relative)
- `from .. import parent` (relative)
- `from .package import module`
- `import X as Y`
- `from X import *`

**Downstream impact:** Breaks `find_references`, `get_knowledge_map`, `detect_communities`, `impact_analysis`, and `trace_call_chain` for Python codebases.

### 1.3 LSP Support

- **Server:** `pylsp` (Python Language Server)
- **Configured:** Yes, minimal config (no args/initOptions)
- **Capabilities via LSP:** go-to-definition, find-references, type info (hover), call hierarchy, rename symbol
- **Limitation:** Requires user to `pip install python-lsp-server`

### 1.4 Framework Detection (`src/tools/project-tools.ts`)

Good detection of:
- FastAPI (`router.py`, `routes.py` files)
- Django (`views.py`, `urls.py` files)
- Flask (`blueprint*` files)
- pytest (`conftest.py`, `test_*.py`)
- Models directory detection
- Middleware detection

**Missing:** No actual framework-specific analysis beyond detection. Framework type is reported but not used for deeper analysis.

### 1.5 Route Tracing (`src/tools/route-tools.ts`)

**NO Python framework support.** Only NestJS, Next.js App Router, and Express are implemented.

No handling of:
- Django `urlpatterns` + `include()` chains
- Flask `@app.route()` / Blueprint routes
- FastAPI `@app.get()` / `APIRouter`

### 1.6 Pattern Detection (`src/tools/pattern-tools.ts`)

**Zero Python-specific patterns.** All 9 built-in patterns are JS/TS focused:
- `useEffect-no-cleanup`, `empty-catch`, `any-type`, `console-log`, `await-in-loop`, `no-error-type`, `toctou`, `unbounded-findmany`, `scaffolding`

### 1.7 Test Coverage

- **No dedicated Python extractor tests** (no `tests/parser/python-extractor.test.ts`)
- **No Python test fixtures** in `tests/fixtures/`
- Only smoke tests: `getServerName("python")` returns `"pylsp"`, Python routed to extractor

### 1.8 Summary Scorecard

| Dimension | Grade | Notes |
|-----------|-------|-------|
| Symbol extraction | B | Core extraction works, missing Python-specific constructs |
| Import graph | F | Zero Python support |
| LSP integration | B+ | Full pylsp integration, needs install |
| Framework detection | B | Detects frameworks, no deep analysis |
| Route tracing | F | No Python framework support |
| Pattern detection | F | No Python patterns |
| Test coverage | F | No Python-specific tests |
| Overall | C- | Basic parsing works; no Python-aware intelligence |

---

## Part 2: Competitive Analysis

### 2.1 Serena (22.7K stars)

- **Written in Python**, LSP-based, 40+ language support
- **Python support:** First-class — uses Pyright or pylsp as backend
- **Strengths:** Semantic code retrieval, symbol-level editing, find references, go-to-definition
- **Framework support:** Generic via LSP — no Django/Flask-specific route tracing
- **Gap vs CodeSift:** No graph analysis, no anti-pattern detection, no route tracing, no dead code analysis
- **What they do better:** LSP integration is tighter since they're Python-native

### 2.2 CodePathfinder (codepathfinder.dev)

- **Python-focused** MCP server, Apache-2.0
- **5-pass AST analysis:** symbol tables, call graph, type inference, import resolution, dataflow tracking
- **6 tools:** `find_symbol`, `get_callers`, `get_callees`, `get_call_details`, `resolve_import`, `get_index_info`
- **Performance:** 50K+ Python files in 8 minutes (M2 Max), <100ms query
- **Strengths:** Call graph construction, taint analysis, import resolution
- **Gap vs CodeSift:** Narrow (6 tools vs 66), Python-only, no search, no semantic search, no pattern detection
- **THREAT:** Direct competitor for Python call chain analysis — their `get_callers`/`get_callees` is what CodeSift's `trace_call_chain` should do for Python

### 2.3 mcp-server-analyzer

- **Integrates Ruff + Vulture** as MCP tools
- **Simple wrapper:** Runs ruff/vulture CLI and returns results
- **Gap vs CodeSift:** Shell wrapper approach, no AST integration, no graph analysis
- **Lesson:** Quick to build, shows demand for Python linting in MCP

### 2.4 mcp-tools-py

- **Integrates pylint + pytest** as MCP tools
- **Runs checks with LLM-friendly prompts** for analysis and fixes
- **Gap vs CodeSift:** Narrow scope, but validates demand for pytest integration

### 2.5 codedb (justrach, 606 stars)

- **Zig binary**, supports Python among 6 languages
- **Python-specific:** Docstring parsing improvements
- **12 tools:** Tree, outline, symbols, search, edit, snapshot
- **Gap vs CodeSift:** No call graph, no semantic search, no pattern detection
- **No framework-specific Python analysis**

### 2.6 CodeGraphMCPServer

- **Python-based**, GraphRAG with Louvain community detection
- **LLM integration** for semantic understanding
- **No framework-specific analysis**

### 2.7 Competitive Summary

| Capability | CodeSift | Serena | CodePathfinder | mcp-analyzer | codedb |
|-----------|----------|--------|----------------|-------------|--------|
| Python AST parsing | tree-sitter | LSP | custom 5-pass | ruff/vulture | custom |
| Call graph | Generic | Via LSP | YES (Python) | No | No |
| Import resolution | NO | Via LSP | YES (Python) | No | No |
| Django/Flask routes | NO | No | No | No | No |
| Anti-patterns | NO (Python) | No | No | Via Ruff | No |
| Dead code | Generic | No | No | Via Vulture | No |
| Semantic search | YES | No | No | No | No |
| N+1 query detection | No | No | No | No | No |
| pytest fixtures | Basic | No | No | Via pytest | No |
| Model relationships | No | No | No | No | No |

**Key insight:** Nobody does framework-aware Python analysis via MCP. This is a wide-open differentiation opportunity.

---

## Part 3: Brainstorm — New Tools & Extensions

### Priority Tier 1: Foundation (enables everything else)

#### 1A. Python Import Graph

**Extend:** `src/utils/import-graph.ts` — add Python import patterns

```
IMPORT_PATTERNS += [
  /^import\s+(\S+)/gm,                           // import module
  /^from\s+(\S+)\s+import\s+/gm,                 // from module import ...
]
```

Plus Python-specific resolution:
- Relative imports (`from . import X`) resolved via `__init__.py`
- `__init__.py` re-exports tracked
- `__all__` parsed to determine public API
- `.py` extension resolution (not `.ts`/`.js`)

**Unlocks:** `find_references`, `get_knowledge_map`, `detect_communities`, `impact_analysis` for Python.

**Effort:** Medium — ~200 lines in import-graph.ts + new `resolveImportPathPython()` function.

#### 1B. Python Extractor Enhancements

**Extend:** `src/parser/extractors/python.ts`

| Enhancement | New Kind / Field | Detection |
|-------------|-----------------|-----------|
| `async def` | tag: `async` on existing kind | Check for `async` keyword in function_definition |
| `@dataclass` | kind: `class` + tag `dataclass`, extract fields | Decorator check + class body field extraction |
| `@property` | kind: `property` | Decorator check |
| `@classmethod` / `@staticmethod` | kind: `classmethod` / `staticmethod` | Decorator check |
| `__dunder__` methods | tag: `dunder` | Name pattern check |
| Module-level constants | kind: `constant` / `variable` | Top-level assignment with UPPER_CASE name |
| `__all__` | stored on file metadata | Parse list literal at module level |
| Superclass list | `extends` field on CodeSymbol | Parse `superclasses` field |

**Effort:** Medium — ~150 lines, no new SymbolKind types needed (use existing + tags).

#### 1C. Python Extractor Tests

**New file:** `tests/parser/python-extractor.test.ts`

Test cases needed:
- Functions with decorators, docstrings, type hints, async
- Classes with inheritance, dataclass, properties, classmethods
- pytest fixtures with scope variations
- Module-level constants and `__all__`
- Nested classes and functions
- Edge cases: empty functions, decorator chains

**Effort:** Small — ~200 lines of test code + Python fixture files.

---

### Priority Tier 2: Framework-Aware Intelligence (differentiation)

#### 2A. `trace_route` for Python Frameworks

**Extend:** `src/tools/route-tools.ts`

**Django:**
```python
# urls.py
urlpatterns = [
    path('users/<int:pk>/', views.user_detail, name='user-detail'),
    path('api/', include('api.urls')),
]
```
- Parse `urlpatterns` lists from `urls.py` files
- Follow `include()` chains recursively
- Resolve view functions (function views + class-based views)
- Extract URL parameters (`<int:pk>`, `<slug:slug>`)
- Build: URL -> view -> service -> model chain

**Flask:**
```python
@app.route('/users/<int:user_id>', methods=['GET', 'POST'])
def user_detail(user_id):
    ...

# Blueprint
bp = Blueprint('auth', __name__)
@bp.route('/login')
def login():
    ...
```
- Parse `@app.route()` and `@bp.route()` decorators
- Extract Blueprint prefix + route path
- Resolve handler functions

**FastAPI:**
```python
@app.get('/users/{user_id}', response_model=UserResponse)
async def get_user(user_id: int, db: Session = Depends(get_db)):
    ...

router = APIRouter(prefix='/api/v1')
@router.post('/items/')
async def create_item(item: ItemCreate):
    ...
```
- Parse `@app.get/post/put/delete()` decorators
- Extract `APIRouter` prefix
- Parse `Depends()` dependency chain
- Extract Pydantic response/request models

**Effort:** Large — ~400 lines, but massive differentiation value. Nobody else does this via MCP.

#### 2B. `python_patterns` — Built-in Anti-Pattern Detection

**Extend:** `src/tools/pattern-tools.ts` — add Python-specific BUILTIN_PATTERNS

| Pattern Name | Regex/AST Query | Severity |
|-------------|----------------|----------|
| `mutable-default` | `def\s+\w+\s*\([^)]*=\s*(\[\]|\{\}|set\(\))` | HIGH |
| `bare-except` | `except\s*:` | HIGH |
| `broad-except` | `except\s+(Exception|BaseException)\s*:` | HIGH |
| `global-keyword` | `\bglobal\s+\w+` | MEDIUM |
| `star-import` | `from\s+\S+\s+import\s+\*` | MEDIUM |
| `print-debug` | `\bprint\s*\(` (in non-CLI code) | LOW |
| `eval-exec` | `\b(eval|exec)\s*\(` | HIGH |
| `shell-true` | `subprocess\.\w+\([^)]*shell\s*=\s*True` | HIGH |
| `pickle-load` | `pickle\.(load|loads)\s*\(` | HIGH |
| `yaml-unsafe` | `yaml\.load\s*\([^)]*(?!Loader)` | HIGH |
| `open-no-with` | `\bopen\s*\([^)]*\)` outside `with` | MEDIUM |
| `string-concat-loop` | `\+=\s*['"]` inside loop | MEDIUM |
| `datetime-naive` | `datetime\.(now|utcnow)\s*\(\s*\)` | MEDIUM |
| `shadow-builtin` | Assignment to `list`, `dict`, `set`, `id`, `type`, `input`, `map`, `filter` | MEDIUM |
| `n-plus-one-django` | Loop + `.related_field` without prior `select_related`/`prefetch_related` | HIGH |
| `late-binding` | `lambda` capturing loop variable | HIGH |
| `assert-tuple` | `assert\s*\(` (always True) | HIGH |

**Effort:** Medium — ~100 lines of regex patterns. Some complex patterns (N+1) may need AST queries.

#### 2C. `get_model_graph` — ORM Model Relationships

**New tool** (hidden/discoverable)

For Django:
```python
# Parse models.py files
class Author(models.Model):
    name = models.CharField(max_length=100)

class Book(models.Model):
    title = models.CharField(max_length=200)
    author = models.ForeignKey(Author, on_delete=models.CASCADE)
    tags = models.ManyToManyField('Tag')
```

Extract:
- Model names and fields
- `ForeignKey`, `OneToOneField`, `ManyToManyField` relationships
- `on_delete` behavior
- Abstract models and inheritance chains
- Through tables for M2M

For SQLAlchemy:
```python
class User(Base):
    __tablename__ = 'users'
    id = Column(Integer, primary_key=True)
    posts = relationship("Post", back_populates="author")
```

Output: structured graph or mermaid diagram of entity relationships.

**Effort:** Large — ~300 lines. New tool file `src/tools/model-tools.ts`.

---

### Priority Tier 3: Python-Specific Intelligence (nice-to-have)

#### 3A. `get_test_fixtures` — pytest Fixture Graph

**New tool** (hidden/discoverable)

Parse pytest fixture dependencies:
- Scan `conftest.py` hierarchy (project root -> test dir -> test subdir)
- Extract `@pytest.fixture` definitions with scope (`function`/`module`/`session`)
- Build fixture dependency graph (fixture A uses fixture B)
- Detect `autouse=True` fixtures
- Map tests to their fixture dependencies

Output:
```json
{
  "fixtures": [
    { "name": "db", "scope": "session", "file": "conftest.py", "depends_on": ["engine"] },
    { "name": "client", "scope": "function", "file": "tests/conftest.py", "depends_on": ["db", "app"] }
  ],
  "test_dependencies": {
    "test_create_user": ["client", "db", "factory"]
  }
}
```

**Effort:** Medium — ~200 lines. Leverages existing Python extractor for fixture detection.

#### 3B. `find_framework_wiring` — Hidden Control Flow

**New tool** (hidden/discoverable)

Discover implicit connections:
- **Django signals:** `@receiver(post_save, sender=Model)`, `Signal.connect()`
- **Celery tasks:** `@app.task`, `@shared_task`, `delay()` / `apply_async()` call sites
- **Django middleware:** Parse `MIDDLEWARE` from settings
- **Django management commands:** `BaseCommand` subclasses in `management/commands/`
- **Flask extensions:** `init_app()` calls
- **FastAPI event handlers:** `@app.on_event("startup")`

Output: map of implicit wiring points that static analysis normally misses.

**Effort:** Large — ~350 lines. High value for AI agent understanding of Python apps.

#### 3C. `analyze_django_settings` — Configuration Audit

**New tool** (hidden/discoverable)

Parse Django `settings.py` / settings module and check:
- `DEBUG = True` in production settings
- Missing `ALLOWED_HOSTS`
- Insecure `SECRET_KEY` (hardcoded, short, or default)
- Missing security middleware (`SecurityMiddleware`, `CsrfViewMiddleware`)
- Database configuration issues
- `INSTALLED_APPS` vs actual app directories
- Cache configuration

**Effort:** Medium — ~150 lines.

#### 3D. `check_type_coverage` — Type Annotation Audit

**New tool** (hidden/discoverable)

Report:
- % of functions with type annotations (params + return)
- % of public API (in `__all__` or public modules) with full annotations
- Untyped boundary crossings (typed module calling untyped module)
- `Any` usage count and locations
- Missing `-> None` on functions that don't return

**Effort:** Medium — ~150 lines. Uses existing Python extractor signatures.

#### 3E. `find_decorator_semantics` — Decorator Understanding

**Extend:** Python extractor to store decorator metadata

When extracting symbols, also store:
```json
{
  "decorators": ["@app.route('/users')", "@login_required", "@cache(timeout=300)"],
  "decorator_kinds": ["route", "auth", "cache"]
}
```

Known decorator classifications:
- Route: `@app.route`, `@app.get/post/put/delete`, `@router.*`
- Auth: `@login_required`, `@permission_required`, `@requires_auth`
- Cache: `@cache`, `@cached`, `@lru_cache`
- Test: `@pytest.fixture`, `@pytest.mark.*`, `@mock.patch`
- Validation: `@validate`, `@validator`
- ORM: `@property`, `@hybrid_property`

**Effort:** Small — ~80 lines in extractor + decorator classification map.

---

### Priority Tier 4: Meta-Tools (Python ecosystem integration)

#### 4A. `run_ruff` — Ruff Linting Integration

**New tool** (hidden/discoverable)

If `ruff` is installed, run specific rule categories and return structured results:
```
run_ruff(categories=["B", "PERF", "SIM"], file_pattern="src/")
```

Categories worth exposing:
- `B` — bugbear (common bugs: mutable defaults, assert False)
- `PERF` — performance anti-patterns
- `SIM` — simplification opportunities
- `UP` — pyupgrade (legacy syntax)
- `PT` — pytest style issues
- `S` — security (bandit rules)
- `DJ` — Django-specific
- `ASYNC` — async anti-patterns
- `RET` — return statement patterns
- `ARG` — unused arguments

**Effort:** Small — ~100 lines. Shell wrapper with structured output parsing.

**Advantage over mcp-server-analyzer:** Integrated with CodeSift's symbol index — can correlate ruff findings with symbol graph (e.g., "this function flagged by ruff is called from 5 places").

#### 4B. `run_mypy` / `run_pyright` — Type Checking Integration

**New tool** (hidden/discoverable)

Run type checker on specific files and return structured diagnostics:
```
run_type_check(files=["src/models.py"], strict=true)
```

**Effort:** Small — ~80 lines. Shell wrapper with structured output parsing.

#### 4C. `parse_pyproject` — Project Config Analysis

**New tool** (hidden/discoverable)

Parse `pyproject.toml` and return:
- Dependencies with version constraints
- Python version requirement
- Build system
- Configured tools (ruff rules, mypy config, pytest options)
- Entry points / scripts
- Optional dependency groups

**Effort:** Small — ~100 lines. TOML parsing + structured output.

---

## Implementation Roadmap

### Phase 1: Foundation (unblocks everything)
1. **Python import graph** — add patterns to `import-graph.ts` _(1B priority)_
2. **Python extractor enhancements** — async, dataclass, property, dunder, __all__ _(1B priority)_
3. **Python extractor tests** — fixture files + test cases _(1C priority)_

### Phase 2: Framework Intelligence (differentiation)
4. **`trace_route` Python** — Django URL + Flask @route + FastAPI @app.get _(2A priority)_
5. **`python_patterns`** — 17 Python anti-patterns in BUILTIN_PATTERNS _(2B priority)_
6. **`get_model_graph`** — Django/SQLAlchemy model relationships _(2C priority)_

### Phase 3: Python-Specific Tools
7. **`get_test_fixtures`** — pytest fixture dependency graph _(3A priority)_
8. **`find_framework_wiring`** — signals, tasks, middleware _(3B priority)_
9. **`find_decorator_semantics`** — decorator classification _(3E priority)_

### Phase 4: Ecosystem Integration
10. **`run_ruff`** — integrated ruff with symbol correlation _(4A priority)_
11. **`parse_pyproject`** — project config analysis _(4C priority)_
12. **`check_type_coverage`** — type annotation audit _(3D priority)_

### Total new/extended tools: 12
- Extended existing: 3 (import-graph, python extractor, pattern-tools, trace_route)
- New hidden tools: 8 (get_model_graph, get_test_fixtures, find_framework_wiring, analyze_django_settings, check_type_coverage, find_decorator_semantics, run_ruff, parse_pyproject)

---

## Competitive Positioning

After implementation:

| Capability | CodeSift | Serena | CodePathfinder | mcp-analyzer |
|-----------|----------|--------|----------------|-------------|
| Python AST | tree-sitter + enhanced | LSP | 5-pass custom | ruff CLI |
| Import graph | YES | Via LSP | YES | No |
| Call graph | YES | Via LSP | YES | No |
| Django routes | **YES** | No | No | No |
| Flask/FastAPI routes | **YES** | No | No | No |
| Python anti-patterns | **YES (17)** | No | No | Via Ruff |
| Model relationships | **YES** | No | No | No |
| pytest fixtures | **YES** | No | No | Via pytest |
| Semantic search | YES | No | No | No |
| Ruff integration | **YES** | No | No | YES |
| Framework wiring | **YES** | No | No | No |
| Total tools | 66+ | ~15 | 6 | ~4 |

**CodeSift becomes the only MCP server with framework-aware Python intelligence** — understanding not just the code, but Django/Flask/FastAPI conventions, ORM relationships, pytest fixture graphs, and Celery task chains.
