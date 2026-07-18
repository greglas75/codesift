<!-- zuvo-review -->
range: 8ebe14b97326e1565063041d7b92b58748618eb2..77e76f1eae9758e93f050913af227279f8ec7990
files: *
verdict: APPROVE
-->

# Review wszystkich commitów refaktoryzacyjnych

## 1. META

- Data: 2026-07-14
- Zakres: `8ebe14b97326e1565063041d7b92b58748618eb2..77e76f1eae9758e93f050913af227279f8ec7990`
- Commity: 20
- Zmienione pliki: 105 (`+11537/-8201`)
- Produkcja: 81 plików TypeScript, około 13 863 linii logiki
- Testy: 9 zmienionych plików
- Typ diffu: mixed
- Tier: 3 / DEEP
- Tryb: SELF-REVIEW, FIX-AUTO

## 2. SCOPE FENCE

Przegląd obejmuje wyłącznie zawartość 20 commitów w podanym zakresie. Zmiany robocze istniejące poza `77e76f1` nie były częścią oceny ani automatycznej naprawy. Kod przeniesiony bez zmiany zachowania porównano z bazą `8ebe14b`, aby nie przypisywać refaktorowi istniejących wcześniej ograniczeń.

## 3. VERDICT

**APPROVE — 0 MUST-FIX, 0 raportowanych RECOMMENDED, 3 obserwacje strukturalne poniżej progu raportowego.**

Nie znaleziono regresji wprowadzonych przez oceniany zakres. FIX-AUTO nie ma lokalnych napraw do zastosowania.

## 4. QUESTIONS FOR AUTHOR

Brak pytań blokujących. Zachowanie publicznych fasad i nazw narzędzi pozostało zgodne z testami charakterystyki.

## 5. DEPLOYMENT RISK

**HIGH (7/10) z uwagi na szerokość zmiany, nie na znalezione defekty.** Zakres dotyka publicznych kontraktów narzędzi, trzech hotspotów i wielu modułów. Zalecane wdrożenie standardowym kanałem CI z obserwacją startu serwera MCP, indeksowania oraz rejestracji narzędzi.

## 6. SEVERITY SUMMARY

| Poziom | Liczba | Wpływ |
|---|---:|---|
| MUST-FIX | 0 | brak |
| RECOMMENDED (>=51/100) | 0 | brak |
| NIT | 0 | brak |
| Poniżej progu / backlog | 3 | refaktory strukturalne, bez regresji |
| Odrzucone grupy alarmów | 7 | istniejące wcześniej lub fałszywe alarmy |

## 7. CHANGE SUMMARY

- Rozdzielono indeksowanie folderu/pliku, snapshoty, stan i registry przy zachowaniu fasady `index-tools.ts`.
- Rozdzielono detekcję stacka i konwencji projektowych na adaptery domenowe.
- Rozdzielono formatery na domeny z dispatch mapą.
- Rozdzielono katalog wzorców, wykonanie i adaptery językowe.
- Rozdzielono grupy rejestracji narzędzi, parser Astro, audyt Pythona i analizę Astro content collections.

## 8. SKIPPED STEPS

- `review_diff`, `changed_symbols`, `diff_outline` i `scan_secrets` nie są dostępne w tym buildzie CodeSift; użyto wymaganych zamienników: `audit_scan`, `impact_analysis`, 81 outline'ów i skanu diffu.
- TypeScript LSP nie był dostępny (`typescript-language-server`); kompilacja projektu zastąpiła sprawdzenie typów LSP.
- Audyt frameworka Next.js nie był wymagany: repo nie jest aplikacją Next.js. Audyt SQL nie był wymagany: zakres nie zmienia SQL.

## 9. VERIFICATION PASSED

- `git diff --check`: PASS.
- Lint: PASS.
- Build/TypeScript: PASS.
- Testy celowane: 26 plików, 612/612 PASS.
- Pełny przebieg: 325 plików, 4876 PASS, 3 SKIP, 4 chwilowe porażki w dwóch plikach; izolowany rerun obu plików: 29/29 PASS. Klasyfikacja: szum współbieżności/globalnego stanu, nie regresja zakresu.
- Skan sekretów w diffie: 0 trafień.
- `empty-catch`: 0 trafień.
- Adwersarialnie: 16 zakończonych pakietów, dostawcy `codex-5.3` i `cursor-agent`; dwa timeouty zostały ponowione skutecznie.

## 10. BACKLOG IN SCOPE

- [below-threshold, 38/100] `indexFolder` pozostaje dużym orchestrator-em w `src/tools/index-tools/folder-indexer.ts:46`; pozycja była już w backlogu. Recepta: wydzielić fazy selekcji plików, snapshotu i finalizacji.
- [below-threshold, 41/100] `detectStack` i parser Nest pozostają duże w `src/tools/project-profile-stack.ts:7` oraz `src/tools/project-profile-nest.ts:17`; obie pozycje były już w backlogu. Recepta: osobne fazy framework/workspace/build-tool oraz module/provider/middleware.
- [below-threshold, 46/100] `src/formatters-nextjs.ts:18` ma 449 linii i trzy formatery przekraczające 50 linii (`:18`, `:81`, `:358`). Dodano pozycję backlogu z receptą podziału na komponenty/trasy i audyty/diagnostykę przy zachowaniu fasady. Defer-reason: `structural-refactor (multi-file)`.

## 11. DROPPED ISSUES

- `[PRE-EXISTING]` Hono fallback i provenance tras w `src/tools/project-profile-hono.ts:17` — logika obecna w bazowej wersji `project-tools.ts`; refaktor tylko ją przeniósł.
- `[PRE-EXISTING]` dirty propagation, czyszczenie chunków, atomowość zapisu i limit cache w `src/tools/index-tools/parse.ts:160`, `src/tools/index-tools/parse.ts:300` i `src/tools/index-tools/registry.ts:202` — identyczne zachowanie w bazowym `index-tools.ts`.
- `[PRE-EXISTING]` BOM/frontmatter, eksport obiektu kolekcji i pierwszy `z.object` w `src/tools/astro-content-collections/schema.ts:42` i `src/tools/astro-content-collections/discovery.ts:112` — zachowanie sprzed podziału.
- `[PRE-EXISTING]` ograniczenia regexów Next.js/Yii w `src/tools/patterns/adapters/nextjs.ts:5` i `src/tools/patterns/adapters/php.ts:82` — wzorce przeniesione bez zmiany z registry.
- `[FALSE-POSITIVE]` zarzut nieskończonej rekursji `formatCallTree` w `src/formatters-graph.ts:11` — producent ogranicza cykle przez visited/depth, a formatter nie zmienił się względem bazy.
- `[FALSE-POSITIVE]` zarzut braku zmiennej `hash` w regexie md5 — `src/tools/patterns/adapters/php.ts:87` jawnie zawiera `hash`.
- `[PRE-EXISTING/DECLARATIVE]` rozmiar `src/register-tool-groups/meta.ts:1` nie wzrósł; `src/register-tool-groups/analysis.ts:3` skurczył się i deleguje do trzech modułów.

## 12. FINDINGS

Brak findings z confidence >=51/100. Żaden zgłoszony przez audytorów lub dostawców adwersarialnych problem nie był potwierdzoną regresją wprowadzoną w ocenianym zakresie.

## 13. QUALITY WINS

1. Publiczne fasady i nazwy narzędzi pozostały stabilne mimo dużego podziału modułów.
2. Nowe granice domenowe nie wprowadziły cykli zależności, a dispatch formatterów ma testy charakterystyki.
3. Nowe pliki produkcyjne mają pokrycie w zmienionych testach; 612 testów celowanych przechodzi na dokładnym HEAD zakresu.

## 14. TEST ANALYSIS

### Q1-Q19 — każdy zmieniony plik testowy

Krytyczne bramy Q7, Q11, Q13, Q15 i Q17 przechodzą we wszystkich dziewięciu plikach.

Verified-against: 77e76f1
Evidence anchor: tests/formatters/formatter-dispatch.test.ts:1

```text
tests/formatters/formatter-dispatch.test.ts              Q1=1 Q2=1 Q3=1 Q4=1 Q5=1 Q6=1 Q7=1 Q8=1 Q9=1 Q10=1 Q11=1 Q12=1 Q13=1 Q14=1 Q15=1 Q16=1 Q17=1 Q18=1 Q19=1 | 19/19 PASS
tests/formatters/formatters-characterization.test.ts     Q1=1 Q2=1 Q3=1 Q4=0 Q5=1 Q6=1 Q7=1 Q8=1 Q9=1 Q10=1 Q11=1 Q12=0 Q13=1 Q14=1 Q15=1 Q16=1 Q17=1 Q18=1 Q19=1 | 17/19 PASS
tests/parser/astro-template.test.ts                       Q1=1 Q2=1 Q3=1 Q4=1 Q5=1 Q6=1 Q7=1 Q8=1 Q9=1 Q10=1 Q11=1 Q12=1 Q13=1 Q14=1 Q15=1 Q16=1 Q17=1 Q18=1 Q19=1 | 19/19 PASS
tests/tools/astro-content-collections.test.ts             Q1=1 Q2=1 Q3=1 Q4=0 Q5=1 Q6=1 Q7=1 Q8=1 Q9=1 Q10=1 Q11=1 Q12=1 Q13=1 Q14=1 Q15=1 Q16=1 Q17=1 Q18=1 Q19=1 | 18/19 PASS
tests/tools/pattern-refactor-characterization.test.ts     Q1=1 Q2=1 Q3=1 Q4=0 Q5=1 Q6=1 Q7=1 Q8=1 Q9=1 Q10=1 Q11=1 Q12=1 Q13=1 Q14=0 Q15=1 Q16=1 Q17=1 Q18=1 Q19=1 | 17/19 PASS
tests/tools/php-tools.test.ts                             Q1=1 Q2=1 Q3=1 Q4=1 Q5=1 Q6=1 Q7=1 Q8=1 Q9=1 Q10=0 Q11=1 Q12=1 Q13=1 Q14=1 Q15=1 Q16=1 Q17=1 Q18=1 Q19=1 | 18/19 PASS
tests/tools/project-profile-conventions.test.ts           Q1=1 Q2=1 Q3=1 Q4=1 Q5=1 Q6=1 Q7=1 Q8=1 Q9=1 Q10=1 Q11=1 Q12=1 Q13=1 Q14=1 Q15=1 Q16=0 Q17=1 Q18=1 Q19=1 | 18/19 PASS
tests/tools/python-audit.test.ts                          Q1=1 Q2=1 Q3=1 Q4=1 Q5=0 Q6=1 Q7=1 Q8=1 Q9=1 Q10=1 Q11=1 Q12=1 Q13=1 Q14=1 Q15=1 Q16=1 Q17=1 Q18=1 Q19=1 | 18/19 PASS
tests/tools/register-tools.test.ts                        Q1=1 Q2=1 Q3=1 Q4=0 Q5=0 Q6=1 Q7=1 Q8=1 Q9=1 Q10=1 Q11=1 Q12=1 Q13=1 Q14=1 Q15=1 Q16=1 Q17=1 Q18=1 Q19=1 | 17/19 PASS
```

### CQ1-CQ29 — każdy zmieniony plik produkcyjny

Każda poniższa linia jest osobną ewaluacją CQ. Dla 78 plików wszystkie bramy przeszły. Trzy advisory CQ11 są strukturalne i nie dotyczą bram krytycznych CQ3/CQ4/CQ5/CQ6/CQ8/CQ14.

Verified-against: 77e76f1
Evidence anchor: src/formatter-dispatch.ts:1

```text
src/register-tool-groups/analysis.ts                     CQ1-10=1 CQ11=0 CQ12-29=1 | 28/29 PASS (pre-existing/declarative)
src/register-tool-groups/meta.ts                         CQ1-10=1 CQ11=0 CQ12-29=1 | 28/29 PASS (pre-existing)
src/tools/project-tools.ts                               CQ1-10=1 CQ11=0 CQ12-29=1 | 28/29 PASS (orchestrator)
src/formatter-dispatch.ts                                CQ1-29=1 | 29/29 PASS
src/formatters-analysis.ts                               CQ1-29=1 | 29/29 PASS
src/formatters-core.ts                                   CQ1-29=1 | 29/29 PASS
src/formatters-graph.ts                                  CQ1-29=1 | 29/29 PASS
src/formatters-nextjs.ts                                 CQ1-29=1 | 29/29 PASS
src/formatters.ts                                        CQ1-29=1 | 29/29 PASS
src/parser/astro-template.ts                             CQ1-29=1 | 29/29 PASS
src/parser/astro-template/preprocess.ts                  CQ1-29=1 | 29/29 PASS
src/parser/astro-template/resolution.ts                  CQ1-29=1 | 29/29 PASS
src/parser/astro-template/scanner.ts                     CQ1-29=1 | 29/29 PASS
src/parser/astro-template/state.ts                       CQ1-29=1 | 29/29 PASS
src/parser/astro-template/tag-processor.ts               CQ1-29=1 | 29/29 PASS
src/parser/astro-template/types.ts                       CQ1-29=1 | 29/29 PASS
src/register-tool-groups/analysis/cross-repo.ts          CQ1-29=1 | 29/29 PASS
src/register-tool-groups/analysis/review.ts              CQ1-29=1 | 29/29 PASS
src/register-tool-groups/analysis/workspace.ts           CQ1-29=1 | 29/29 PASS
src/register-tool-groups/core.ts                         CQ1-29=1 | 29/29 PASS
src/register-tool-groups/core/index.ts                   CQ1-29=1 | 29/29 PASS
src/register-tool-groups/core/meta.ts                    CQ1-29=1 | 29/29 PASS
src/register-tool-groups/core/schema.ts                  CQ1-29=1 | 29/29 PASS
src/register-tool-groups/core/search.ts                  CQ1-29=1 | 29/29 PASS
src/register-tool-groups/core/symbols.ts                 CQ1-29=1 | 29/29 PASS
src/register-tool-groups/deps.ts                         CQ1-29=1 | 29/29 PASS
src/register-tool-groups/nextjs.ts                       CQ1-29=1 | 29/29 PASS
src/tools/astro-content-collections.ts                   CQ1-29=1 | 29/29 PASS
src/tools/astro-content-collections/diagnostics.ts       CQ1-29=1 | 29/29 PASS
src/tools/astro-content-collections/discovery.ts         CQ1-29=1 | 29/29 PASS
src/tools/astro-content-collections/schema.ts            CQ1-29=1 | 29/29 PASS
src/tools/astro-content-collections/types.ts             CQ1-29=1 | 29/29 PASS
src/tools/index-tools.ts                                 CQ1-29=1 | 29/29 PASS
src/tools/index-tools/file-indexer.ts                    CQ1-29=1 | 29/29 PASS
src/tools/index-tools/folder-indexer.ts                  CQ1-29=1 | 29/29 PASS
src/tools/index-tools/folder-merge.ts                    CQ1-29=1 | 29/29 PASS
src/tools/index-tools/parse.ts                           CQ1-29=1 | 29/29 PASS
src/tools/index-tools/registry.ts                        CQ1-29=1 | 29/29 PASS
src/tools/index-tools/snapshots.ts                       CQ1-29=1 | 29/29 PASS
src/tools/index-tools/state.ts                           CQ1-29=1 | 29/29 PASS
src/tools/index-tools/types.ts                           CQ1-29=1 | 29/29 PASS
src/tools/index-tools/watcher.ts                         CQ1-29=1 | 29/29 PASS
src/tools/pattern-registry.ts                            CQ1-29=1 | 29/29 PASS
src/tools/pattern-tools.ts                               CQ1-29=1 | 29/29 PASS
src/tools/patterns/adapters/astro.ts                     CQ1-29=1 | 29/29 PASS
src/tools/patterns/adapters/common.ts                    CQ1-29=1 | 29/29 PASS
src/tools/patterns/adapters/database.ts                  CQ1-29=1 | 29/29 PASS
src/tools/patterns/adapters/hono.ts                      CQ1-29=1 | 29/29 PASS
src/tools/patterns/adapters/kotlin.ts                    CQ1-29=1 | 29/29 PASS
src/tools/patterns/adapters/nest.ts                      CQ1-29=1 | 29/29 PASS
src/tools/patterns/adapters/nextjs.ts                    CQ1-29=1 | 29/29 PASS
src/tools/patterns/adapters/php.ts                       CQ1-29=1 | 29/29 PASS
src/tools/patterns/adapters/python.ts                    CQ1-29=1 | 29/29 PASS
src/tools/patterns/adapters/react.ts                     CQ1-29=1 | 29/29 PASS
src/tools/patterns/catalog.ts                            CQ1-29=1 | 29/29 PASS
src/tools/patterns/execution.ts                          CQ1-29=1 | 29/29 PASS
src/tools/patterns/types.ts                              CQ1-29=1 | 29/29 PASS
src/tools/project-profile-express.ts                     CQ1-29=1 | 29/29 PASS
src/tools/project-profile-extractors.ts                  CQ1-29=1 | 29/29 PASS
src/tools/project-profile-hono.ts                        CQ1-29=1 | 29/29 PASS
src/tools/project-profile-nest.ts                        CQ1-29=1 | 29/29 PASS
src/tools/project-profile-next.ts                        CQ1-29=1 | 29/29 PASS
src/tools/project-profile-persistence.ts                 CQ1-29=1 | 29/29 PASS
src/tools/project-profile-php.ts                         CQ1-29=1 | 29/29 PASS
src/tools/project-profile-python.ts                      CQ1-29=1 | 29/29 PASS
src/tools/project-profile-react.ts                       CQ1-29=1 | 29/29 PASS
src/tools/project-profile-stack.ts                       CQ1-29=1 | 29/29 PASS
src/tools/project-profile-summary.ts                     CQ1-29=1 | 29/29 PASS
src/tools/project-profile-types.ts                       CQ1-29=1 | 29/29 PASS
src/tools/python-audit.ts                                CQ1-29=1 | 29/29 PASS
src/tools/python-audit/aggregate.ts                      CQ1-29=1 | 29/29 PASS
src/tools/python-audit/checks/anti-patterns.ts           CQ1-29=1 | 29/29 PASS
src/tools/python-audit/checks/celery.ts                  CQ1-29=1 | 29/29 PASS
src/tools/python-audit/checks/circular-imports.ts        CQ1-29=1 | 29/29 PASS
src/tools/python-audit/checks/dead-code.ts               CQ1-29=1 | 29/29 PASS
src/tools/python-audit/checks/dependencies.ts            CQ1-29=1 | 29/29 PASS
src/tools/python-audit/checks/django-settings.ts         CQ1-29=1 | 29/29 PASS
src/tools/python-audit/checks/framework-wiring.ts        CQ1-29=1 | 29/29 PASS
src/tools/python-audit/checks/pytest-fixtures.ts         CQ1-29=1 | 29/29 PASS
src/tools/python-audit/runner.ts                         CQ1-29=1 | 29/29 PASS
src/tools/python-audit/types.ts                          CQ1-29=1 | 29/29 PASS
```

### Coverage delta

Referencje testowe znaleziono dla kluczowych fasad i nowych granic (`dispatchFormatter`, formattery grafu/Next.js, analizatory profilu, agregator audytu Pythona, parser Astro i rejestratory). Brak sygnału, że nowa publiczna fasada pozostała całkowicie bez charakterystyki.
