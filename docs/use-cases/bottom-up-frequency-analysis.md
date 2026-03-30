# Bottom-Up Frequency Analysis

> Don't decide what to look for. Extract what's most common. Then evaluate.

---

## The Idea

Top-down scanning (regex checklist) has a blind spot: **you only find what you already know to look for**. Bottom-up inverts this — extract ALL patterns, rank by frequency, let the data surface what matters.

One perl one-liner + `sort | uniq -c | sort -rn` gives you the real distribution. No bias. No preselection.

---

## Method

### Test assertions — what do your tests actually check?

```bash
find . -type f \( -name '*.test.ts' -o -name '*.spec.ts' \) \
  -not -path '*/node_modules/*' \
  -exec perl -nle '
    while (/expect\(.*?\)\.([\w]+)\(/g) { print $1 }
  ' {} + | sort | uniq -c | sort -rn | head -25
```

### Test assertion shapes — normalized (X replaces variables, N replaces numbers)

```bash
find . -type f \( -name '*.test.ts' -o -name '*.spec.ts' \) \
  -not -path '*/node_modules/*' \
  -exec perl -nle '
    while (/expect\(([^)]+)\)\.([\w]+)\(([^)]*)\)/g) {
      $arg=$1; $meth=$2; $val=$3;
      $arg =~ s/"[^"]*"/STR/g; $arg =~ s/\d+/N/g;
      $val =~ s/"[^"]*"/STR/g; $val =~ s/\d+/N/g;
      $arg =~ s/[a-z]\w*\.length/X.length/g;
      $arg =~ s/[a-z]\w*\.[a-z]\w*/X.prop/g;
      $arg =~ s/[a-z]\w+/X/g;
      $val =~ s/[a-z]\w+/X/g;
      print "expect($arg).$meth($val)";
    }
  ' {} + | sort | uniq -c | sort -rn | head -30
```

### Production code — statement pattern frequency

```bash
find . -type f -name '*.ts' \
  -not -path '*/node_modules/*' -not -path '*/dist/*' \
  -not -name '*.test.*' -not -name '*.spec.*' \
  -exec perl -nle '
    if (/\.(map|filter|forEach|reduce|find|some|every|flatMap)\(/) { print "array.$1()" }
    if (/await\s+[\w.]+\.(find|findMany|findFirst|findUnique|create|update|delete|upsert|count|aggregate)\(/) { print "db.$1()" }
    if (/throw new (\w+)/) { print "throw new $1" }
    if (/console\.(log|warn|error|info|debug)\(/) { print "console.$1()" }
    if (/process\.env\./) { print "process.env.X" }
    if (/new Date\(/) { print "new Date()" }
    if (/as any/) { print "as any" }
    if (/JSON\.parse\(/) { print "JSON.parse()" }
    if (/JSON\.stringify\(/) { print "JSON.stringify()" }
    if (/catch\s*\((\w+)/) { print "catch($1)" }
    if (/\.then\(/) { print ".then()" }
    if (/setTimeout\(|setInterval\(/) { print "setTimeout/setInterval" }
  ' {} + | sort | uniq -c | sort -rn | head -40
```

### Catch block style — how consistent is error handling?

```bash
find . -type f -name '*.ts' \
  -not -path '*/node_modules/*' -not -name '*.test.*' -not -name '*.spec.*' \
  -exec perl -nle '
    while (/(\} *catch *\([^)]*\) *\{.*)/g) {
      $l=$1; $l=~s/\s+/ /g; print substr($l,0,80)
    }
  ' {} + | sort | uniq -c | sort -rn | head -20
```

---

## Real Results (3 repos)

### Test assertion methods — tgm-survey-platform (55K assertions)

```
22,140  toBe                   ← #1, most specific — GOOD
 8,742  toBeInTheDocument      ← DOM testing — FINE
 8,101  toHaveBeenCalledWith   ← mock verification — OK
 6,822  toEqual                ← structural equality — GOOD
 2,790  toHaveLength           ← proper length check — GOOD
 2,558  toContain              ← substring/array — OK
 2,182  toBeNull               ← specific null check — FINE
 1,798  toHaveBeenCalledTimes  ← mock count — OK
───────────────────────────────── weakness line ──────
   808  toBeGreaterThan        ← VAGUE QUANTITY (1.5%)
   544  toBeDefined            ← EXISTENCE ONLY (1.0%)
   201  toBeTruthy             ← WEAKEST (0.4%)
```

**Insight:** Weak assertions are only **2.9%** of all assertions. Sounds small — but 1,553 assertions that prove almost nothing is still 1,553 chances to miss a bug. And `toBeGreaterThan` (808) outranks `toBeDefined` (544) — it's the bigger fix target.

### Test assertion methods — translation-qa (120K assertions)

```
54,338  toBe
11,812  toBeInTheDocument
11,136  toHaveBeenCalledWith
10,907  toContain
 7,969  toEqual
 5,148  toHaveLength
───────────────────────────────── weakness line ──────
 2,232  toBeGreaterThan        ← 1.9%
 1,974  toBeDefined            ← 1.6%
   669  toBeCloseTo            ← float comparison (legitimate)
   315  toBeLessThanOrEqual
```

**Insight:** Same pattern as tgm — `toBeGreaterThan` outranks `toBeDefined`. The ratio is consistent across repos.

### Normalized assertion shapes — what exactly are tests checking?

**tgm-survey-platform:**
```
1,782  expect(X.prop).toBe(N)           ← prop equals number — GOOD
1,113  expect(X.prop.prop).toBe(X)      ← deep prop equals var — OK
1,021  expect(X).toHaveLength(N)        ← proper length — GOOD
1,008  expect(X.prop).toBe(X)           ← prop equals var — GOOD
  998  expect(X.prop).toBe('STR')       ← prop equals string — GOOD
  427  expect(X.prop).toBeGreaterThan(N) ← VAGUE
  292  expect(X).toEqual([])            ← EMPTY CHECK
  280  expect(X.prop).toEqual([])       ← EMPTY CHECK (572 combined)
  218  expect(X).toBeDefined()          ← EXISTENCE ONLY
```

**translation-qa:**
```
6,849  expect(X.prop).toBe(N)
5,315  expect(X.prop).toBe(X)
2,466  expect(X).toHaveLength(N)
  882  expect(X).toBeDefined()          ← 3× higher than tgm
  822  expect(X.prop).toBeGreaterThan(N)
  714  expect(X.prop).toEqual([])       ← EMPTY CHECK
  581  expect(X).toEqual([])            ← (1,295 combined)
  423  expect(X.prop).toBeDefined()
```

**Cross-repo insight:** `toEqual([])` appears in 2 variants and ranks as the **3rd most common "suspicious" shape** — above `toBeDefined` in both repos. This pattern wasn't in our original checklist scan.

### Production code patterns — Shield vs tgm-survey-platform

**Shield (legacy NestJS + MongoDB):**
```
 485  array.map()
 287  array.filter()
 244  process.env.X          ← #1 non-obvious: env vars EVERYWHERE
 226  array.find()
 200  new Date()             ← untestable time coupling
 185  as any                 ← type safety defeated
 184  console.log()          ← production logging
  90  db.findOne()
  71  catch(err)             ← 5 different catch variable names:
  68  catch(e)                  err(71), e(68), error(64), ex(21), er(6)
  64  catch(error)              = ZERO consistency
  57  setTimeout/setInterval
  30  .then()                ← promise chains (should be async/await)
  21  catch(ex)
```

**tgm-survey-platform (modern NestJS + Prisma):**
```
1,030  array.map()
  477  array.filter()
  197  throw new BadRequestException   ← domain exceptions, GOOD
  159  throw new NotFoundException
  133  array.find()
  111  prisma.findFirst()
  105  prisma.findMany()
   97  new Date()
   92  prisma.update()
   82  throw new Error                ← generic (vs 197 domain)
   68  throw new ForbiddenException
```

**Cross-repo insight:**
- Shield's **top non-collection pattern is `process.env.X` (244×)** — not `as any`, not catch. This is invisible in a top-down scan that doesn't check env scattering.
- Shield has **5 different catch variable names** (`err`, `e`, `error`, `ex`, `er`) = **zero convention** across 289 catch blocks.
- tgm uses domain exceptions (`BadRequestException` 197×, `NotFoundException` 159×) while Shield falls back to generic `Error` (21×). **Structural maturity shows in throw patterns.**

### Catch block consistency — tgm-survey-platform

```
 320  } catch (err: unknown) {     ← typed, consistent — GOOD
 170  } catch (error) {            ← untyped, but named
  90  } catch (err) {              ← untyped
  26  } catch (error: unknown) {   ← typed, different name
```

**Insight:** tgm is **60% typed catch** (`err: unknown` 320 + `error: unknown` 26 = 346 out of 580). Still 40% untyped — but trending in the right direction. Shield is 0% typed.

---

## What This Reveals (vs Top-Down Scanning)

| Discovery | Top-down would have found it? | How bottom-up found it |
|-----------|-------------------------------|----------------------|
| `toEqual([])` is 3rd most suspicious assertion shape | No — wasn't in our checklist | Normalized shape frequency, 2 variants combined |
| `process.env` is Shield's #1 pattern (not `as any`) | Partially — we scanned for it, but didn't know the RANK | Frequency ranking put it above as any |
| 5 different catch variable names in Shield | No — we checked for untyped, not inconsistency | `catch($1)` extraction showed 5 variants |
| `toBeGreaterThan` outranks `toBeDefined` everywhere | No — we scanned separately, never compared | Same frequency table, side by side |
| tgm uses domain exceptions 4× more than generic Error | No — we only scanned for catch patterns | `throw new X` extraction |
| 60% of tgm catch blocks are typed, 0% in Shield | No — we checked presence, not ratio | Same pattern, two repos |

---

## Levels of Quality Mining

| Level | Method | What it finds | Available today? |
|-------|--------|---------------|:----------------:|
| **1. Checklist** | Predefined regex patterns | Known anti-patterns at scale | Yes — `search_patterns` + `search_text` |
| **2. Bottom-up frequency** | Extract → normalize → rank → evaluate | Unknown patterns hiding in frequency data | Yes — perl + sort (or CodeSift `search_text` + `group_by_file`) |
| **3. AST subtree clustering** | Parse all functions → cluster by normalized AST shape → show top N | Structural patterns invisible to regex (e.g., similar control flow) | Partial — `find_clones` does pairwise, not clustering |
| **4. Defect correlation** | Cross-reference pattern frequency with git blame + issue tracker | Which patterns actually cause bugs | Not yet — needs git history + issue tracker integration |

**Level 2 is the sweet spot today.** One perl command gives you what no predefined checklist can: the actual distribution of your codebase's habits. The evaluation step is still human — but the data collection is instant.

---

## How to Run This with CodeSift + AI Agent

Today (Level 1 + partial Level 2):

```
# Level 1: Known patterns
search_patterns(repo, "empty-catch", include_tests=false)
search_text(repo, "\\.toBeDefined\\(\\)", regex=true, file_pattern="test", group_by_file=true)

# Level 2: Bottom-up (via bash, not native CodeSift yet)
# Run the perl one-liners above, feed output to agent for evaluation
```

Future (native Level 2):

```
# Proposed new tool
frequency_analysis(repo, file_pattern="test", category="assertions")
# Returns: { "toBe": 22140, "toBeInTheDocument": 8742, ... }

frequency_analysis(repo, file_pattern="src", category="error_handling")
# Returns: { "catch(err: unknown)": 320, "catch(error)": 170, ... }
```

The agent sees the frequency table, identifies anomalies, and asks: "You have 5 different catch variable names. Is that intentional?"
