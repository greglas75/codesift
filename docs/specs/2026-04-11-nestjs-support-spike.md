# NestJS Parser Feasibility Spike

**Date:** 2026-04-11
**Verdict:** PASS (regex sufficient with one refinement needed)

## Findings

### 1. @Injectable class detection — PASS (all 3/3)
- Simple `@Injectable()` ✓
- With scope options `@Injectable({ scope: Scope.REQUEST })` ✓
- Stacked decorators `@Injectable() @UseGuards(AuthGuard)` ✓
- Regex: `/@Injectable\s*\([\s\S]*?\)\s*(?:export\s+)?class\s+(\w+)/g`

### 2. @UseGuards chain extraction — PASS (all 3/3)
- Single guard `@UseGuards(AuthGuard)` ✓
- Multiple guards `@UseGuards(AuthGuard, RolesGuard)` ✓
- Mixed with @UseInterceptors ✓
- Regex: `/@UseGuards\s*\(\s*([\w\s,]+)\s*\)/g`

### 3. Constructor injection extraction — PARTIAL (2/5)
- Simple `constructor(private readonly x: T)` ✓
- Multi-line ✓
- With `@InjectRepository(User)` — FAILS (lazy `*?` in regex stops at first `)`)
- With `@Optional()` — FAILS (same paren issue)
- With `@Inject(forwardRef(() => ...))` — FAILS (nested parens)

**Root cause:** `RE_CONSTRUCTOR = /constructor\s*\(([\s\S]*?)\)/` uses lazy
quantifier that matches the first `)` inside decorator parens.

**Fix for Task 7:** Use line-based scanning instead of single regex:
1. Find `constructor(` start position
2. Count parens to find matching `)`
3. Extract type annotations from the captured region
This is identical to the pattern used in `extractNestConventions` (line scanning).

## Decision
Proceed with B-series implementation. Regex approach is sufficient for
@Injectable, @UseGuards, @Module, and lifecycle hooks. Constructor
injection needs paren-counting (not AST) — handled in Task 7.
