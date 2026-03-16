#!/bin/bash
# Bash baseline benchmark — measures token output for equivalent operations
# Token estimation: chars / 4

REPO_ROOT="/Users/greglas/DEV/Methodology Platform/promptvault"
TOTAL_TOKENS=0
GREP_EXCLUDE="--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=dist --exclude-dir=.codesift"

tokens() {
  echo $(( ($1 + 3) / 4 ))
}

run_task() {
  local task="$1"
  local cmd="$2"
  local start_ms=$(python3 -c 'import time; print(int(time.time()*1000))')
  local output
  output=$(eval "$cmd" 2>/dev/null)
  local end_ms=$(python3 -c 'import time; print(int(time.time()*1000))')
  local ms=$(( end_ms - start_ms ))
  local chars=${#output}
  local tok=$(tokens "$chars")
  TOTAL_TOKENS=$(( TOTAL_TOKENS + tok ))
  printf "  %-50s %7d tok  %5dms\n" "$task" "$tok" "$ms"
}

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║          Bash Baseline Benchmark (grep/find/ls)              ║"
echo "╠═══════════════════════════════════════════════════════════════╣"
echo "║  Repo: local/promptvault                                     ║"
echo "║  Date: $(date +%Y-%m-%d)                                            ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo

# Category A: Text Search
echo "━━━ Category A: Text Search (grep -rn) ━━━"
A_START=$TOTAL_TOKENS

run_task "A1: prisma.\$transaction in *.service.ts" \
  "grep -rn $GREP_EXCLUDE --include='*.service.ts' 'prisma\.\\\$transaction' '$REPO_ROOT/src'"

run_task "A2: @/lib/errors" \
  "grep -rn $GREP_EXCLUDE '@/lib/errors' '$REPO_ROOT/src'"

run_task "A3: TODO|FIXME in src/" \
  "grep -rnE $GREP_EXCLUDE 'TODO|FIXME' '$REPO_ROOT/src'"

run_task "A4: withAuth" \
  "grep -rn $GREP_EXCLUDE 'withAuth' '$REPO_ROOT/src'"

run_task "A5: process.env" \
  "grep -rnE $GREP_EXCLUDE 'process\.env' '$REPO_ROOT/src'"

run_task "A6: async function.*Risk" \
  "grep -rnE $GREP_EXCLUDE 'async function.*Risk' '$REPO_ROOT/src'"

run_task "A7: throw new AppError" \
  "grep -rn $GREP_EXCLUDE 'throw new AppError' '$REPO_ROOT/src'"

run_task "A8: redis in src/" \
  "grep -rni $GREP_EXCLUDE 'redis' '$REPO_ROOT/src'"

run_task "A9: export GET|POST|PATCH|DELETE" \
  "grep -rnE $GREP_EXCLUDE 'export (GET|POST|PATCH|DELETE)' '$REPO_ROOT/src'"

run_task "A10: console.log in src/" \
  "grep -rn $GREP_EXCLUDE 'console\.log' '$REPO_ROOT/src'"

A_TOTAL=$(( TOTAL_TOKENS - A_START ))
printf "  %-50s %7d tok\n" "CATEGORY A TOTAL" "$A_TOTAL"
echo

# Category B: Symbol Search
echo "━━━ Category B: Symbol Search (grep -A context) ━━━"
B_START=$TOTAL_TOKENS

run_task "B1: createRisk function" \
  "grep -rnA 10 $GREP_EXCLUDE --include='*.ts' --include='*.tsx' 'function createRisk' '$REPO_ROOT/src'"

run_task "B2: DocumentDetail interface" \
  "grep -rnA 20 $GREP_EXCLUDE --include='*.ts' 'interface DocumentDetail' '$REPO_ROOT/src'"

run_task "B3: use* hooks in *.tsx" \
  "grep -rnE $GREP_EXCLUDE --include='*.tsx' 'function use[A-Z]' '$REPO_ROOT/src' | head -50"

run_task "B5: AuditAction type" \
  "grep -rnA 10 $GREP_EXCLUDE --include='*.ts' 'type AuditAction' '$REPO_ROOT/src'"

run_task "B6: create* functions (top 20)" \
  "grep -rnE $GREP_EXCLUDE --include='*.ts' --include='*.tsx' 'function create[A-Z]' '$REPO_ROOT/src' | head -20"

run_task "B7: RiskSummary interface" \
  "grep -rnA 20 $GREP_EXCLUDE --include='*.ts' 'interface RiskSummary' '$REPO_ROOT/src'"

run_task "B9: RiskPanel in *.tsx" \
  "grep -rnA 10 $GREP_EXCLUDE --include='*.tsx' 'function RiskPanel' '$REPO_ROOT/src'"

run_task "B10: withWorkspace function" \
  "grep -rnA 20 $GREP_EXCLUDE --include='*.ts' --include='*.tsx' 'function withWorkspace' '$REPO_ROOT/src'"

B_TOTAL=$(( TOTAL_TOKENS - B_START ))
printf "  %-50s %7d tok\n" "CATEGORY B TOTAL" "$B_TOTAL"
echo

# Category C: File Structure
echo "━━━ Category C: File Structure (find) ━━━"
C_START=$TOTAL_TOKENS

run_task "C1: src/ tree" \
  "find '$REPO_ROOT/src' -type f -not -path '*/node_modules/*' | sed 's|$REPO_ROOT/||' | sort"

run_task "C3: *.test.* files" \
  "find '$REPO_ROOT/src' -name '*.test.*' -type f | sed 's|$REPO_ROOT/||' | sort"

run_task "C9: full repo file list" \
  "find '$REPO_ROOT' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' | sed 's|$REPO_ROOT/||' | sort"

C_TOTAL=$(( TOTAL_TOKENS - C_START ))
printf "  %-50s %7d tok\n" "CATEGORY C TOTAL" "$C_TOTAL"
echo

# Category E: Relationships
echo "━━━ Category E: Relationships (grep refs) ━━━"
E_START=$TOTAL_TOKENS

run_task "E1: callers of createRisk" \
  "grep -rn $GREP_EXCLUDE --include='*.ts' --include='*.tsx' 'createRisk' '$REPO_ROOT/src' | grep -v 'function createRisk' | grep -v '.test.' | grep -v '.spec.'"

run_task "E4: refs RiskSummary" \
  "grep -rn $GREP_EXCLUDE --include='*.ts' --include='*.tsx' 'RiskSummary' '$REPO_ROOT/src'"

run_task "E5: refs withAuth" \
  "grep -rn $GREP_EXCLUDE --include='*.ts' --include='*.tsx' 'withAuth' '$REPO_ROOT/src'"

run_task "E7: refs getRiskById" \
  "grep -rn $GREP_EXCLUDE --include='*.ts' --include='*.tsx' 'getRiskById' '$REPO_ROOT/src'"

E_TOTAL=$(( TOTAL_TOKENS - E_START ))
printf "  %-50s %7d tok\n" "CATEGORY E TOTAL" "$E_TOTAL"
echo

# list_repos equivalent
echo "━━━ list_repos equivalent ━━━"
L_START=$TOTAL_TOKENS
run_task "ls ~/DEV (dir listing)" \
  "ls -1 ~/DEV/"
L_TOTAL=$(( TOTAL_TOKENS - L_START ))
printf "  %-50s %7d tok\n" "LIST REPOS TOTAL" "$L_TOTAL"
echo

# Sequential 5-query
echo "━━━ Sequential 5 queries (bash) ━━━"
S_START=$TOTAL_TOKENS

run_task "Q1: prisma.\$transaction *.service.ts" \
  "grep -rn $GREP_EXCLUDE --include='*.service.ts' 'prisma\.\\\$transaction' '$REPO_ROOT/src'"

run_task "Q2: createRisk function body" \
  "grep -rnA 10 $GREP_EXCLUDE --include='*.ts' --include='*.tsx' 'function createRisk' '$REPO_ROOT/src'"

run_task "Q3: src/lib/services tree" \
  "find '$REPO_ROOT/src/lib/services' -type f 2>/dev/null | sed 's|$REPO_ROOT/||' | sort"

run_task "Q4: refs withAuth" \
  "grep -rn $GREP_EXCLUDE --include='*.ts' --include='*.tsx' 'withAuth' '$REPO_ROOT/src'"

run_task "Q5: createRisk body (grep)" \
  "grep -rnA 20 $GREP_EXCLUDE --include='*.ts' --include='*.tsx' 'function createRisk' '$REPO_ROOT/src' | head -50"

S_TOTAL=$(( TOTAL_TOKENS - S_START ))
printf "  %-50s %7d tok\n" "SEQUENTIAL 5-QUERY TOTAL" "$S_TOTAL"
echo

echo "═══════════════════════════════════════════════════════════════"
printf "  %-50s %7d tok\n" "GRAND TOTAL" "$TOTAL_TOKENS"
