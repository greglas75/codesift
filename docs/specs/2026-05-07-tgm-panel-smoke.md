[parser] WASM grammar not available for css: Incompatible language version 15. Compatibility range 13 through 14.
[parser] WASM grammar not available for css: Incompatible language version 15. Compatibility range 13 through 14.
[parser] WASM grammar not available for css: Incompatible language version 15. Compatibility range 13 through 14.
# tgm-panel smoke test — PHP/Yii2 toolset

Date: 2026-05-07
Branch: php-yii-extractor
Codebase: tgmdev-tgm-panel-1428ca602529 (1882 PHP files, Yii2 2.0.17, PHP >=7.2)

This report is an end-to-end smoke run of the 10 new PHP/Yii2 tools
against a real production Yii2 codebase. Numbers are diagnostic, not
a finished audit — the goal is to confirm each tool produces output
that makes sense at panel scale.

## Indexing

- repo: `local/tgmdev-tgm-panel-1428ca602529`
- duration: 1838 ms
- files: 1979
- symbols: 13104

## 1. yii3_migration_audit

### M4 — Yii2→Yii3 migration inventory  *(155 ms)*

- scanned_files: **1880**
- total_call_sites: **2541**
- yii_version_detected: `2.0.17`
- php_version_required: `>=7.2.0`
- decision_signal: **high-effort-yii3**
- effort_estimate: **849h – 2547h**

**by_severity:**

| severity | count |
|---|---:|
| critical | 518 |
| high | 1565 |
| medium | 208 |
| low | 250 |

**Top categories:**

| category | count | severity |
|---|---:|---|
| service-locator | 394 | critical |
| active-record | 116 | critical |
| module | 8 | critical |
| request | 272 | high |
| view | 201 | high |
| validators | 200 | high |
| user-identity | 195 | high |
| widgets | 116 | high |
| logger | 112 | high |
| rbac | 106 | high |
| form-model | 98 | high |
| i18n | 71 | high |
| object-factory | 61 | high |
| console | 58 | high |
| aliases | 36 | high |

**Blockers:** 2

- `service-locator` — 204 files
- `active-record` — 116 files

## 2. php8_compat_check

### M3 — PHP 7→8 compatibility gate  *(75 ms)*

- scanned_files: **1880**
- total_findings: **37**
- blocker_for_merge: **true**
- yii_version_warning: YES

> Yii 2.0.17 predates 2.0.49 and has known PHP 8 incompatibilities (BaseObject __construct signature, Connection charset detection, etc). Bump yiisoft/yii2 to ^2.0.49 BEFORE merging the PHP 8 upgrade. 2

**by_severity:**

| severity | count |
|---|---:|
| breaking_8_0 | 24 |
| deprecated_8_1 | 3 |
| deprecated_8_2 | 10 |

**Findings by rule:**

| rule_id | severity | count |
|---|---|---:|
| `ambiguous-ternary` | breaking_8_0 | 24 |
| `core-fn-null-string-arg` | deprecated_8_1 | 3 |
| `utf8-encode-decode` | deprecated_8_2 | 10 |

## 3. find_php8_migration_candidates

### M1 — PHP 8 modernization candidates  *(263 ms)*

- scanned_files: **1880**
- total_candidates: **1380**

**By rule:**

| rule_id | count |
|---|---:|
| `docblock-to-typed-property` | 1139 |
| `readonly-candidate` | 126 |
| `nullable-flag-to-syntax` | 49 |
| `enum-from-class-consts` | 33 |
| `promotable-ctor` | 31 |
| `match-from-switch` | 2 |

## 4. find_yii3_attribute_candidates

### M2 — Yii3 attribute conversion candidates  *(6 ms)*

- scanned_files: **1880**
- total_candidates: **1026**

**By rule:**

| rule_id | count |
|---|---:|
| `rules-to-attributes` | 989 |
| `behaviors-to-attributes` | 29 |
| `urlmanager-rule-to-route` | 8 |

## 5. analyze_yii_modules

### N1 — Yii2 module inventory  *(35 ms)*

- total_modules: **10**

| id | controllerNamespace | controllers | views_count | migrations | submodules | url_prefixes |
|---|---|---:|---:|---:|---|---|
| api | (default) | 2 | 0 | 0 | — | — |
| events | (default) | 0 | 0 | 0 | — | — |
| lucid2 | (default) | 3 | 0 | 0 | — | — |
| lucidMonetization | (default) | 2 | 0 | 0 | — | — |
| manage | (default) | 38 | 126 | 0 | — | — |
| manageApi | (default) | 1 | 0 | 0 | — | — |
| payments | (default) | 2 | 0 | 0 | — | — |
| reports | (default) | 0 | 0 | 0 | — | — |
| tgmapi | (default) | 28 | 0 | 0 | — | — |
| verifier | (default) | 2 | 0 | 0 | — | — |

## 6. analyze_yii_migrations

### N2 — Yii2 PHP-DSL migration audit  *(49 ms)*

- scanned_files: **377**
- total_migrations: **377**
- distinct_tables: **122**

**Findings summary:**

| rule_id | count |
|---|---:|
| `alter-without-online-ddl` | 186 |
| `missing-safe-down` | 43 |
| `fk-without-index` | 50 |
| `raw-sql-without-comment` | 15 |

**Top 10 most-touched tables:**

| table | migration_count |
|---|---:|
| mod_user | 24 |
| panel | 23 |
| template_email | 14 |
| transactions | 8 |
| cint_respondent | 7 |
| survey_status_log | 6 |
| cint_opportunity | 6 |
| payment_methods | 6 |
| registration_campaign | 6 |
| {{%user}} | 5 |

## 7. analyze_yii_rbac

### N3 — Yii2 RBAC permission graph  *(46 ms)*

- total_permissions: **0**
- total_roles: **0**
- total_checks: **1**
- orphan_check_count: **1** (checked but never defined)
- unused_definition_count: **0** (defined but never checked)
- unsafe_controller_count: **128** (no AccessControl)
- dynamic_creates: **7**

**Sample orphan checks (first 10):**

- `admin`

## 8. analyze_yii_console_commands

### N4 — Yii2 console command inventory  *(14 ms)*

- total_controllers: **38**
- total_actions: **76**
- high_risk_actions: **53** (≥2 flags)

**Top 10 highest-risk actions:**

| cli_id | flags |
|---|---|
| `cint-sync/questions` | exits-without-return-status, has-unbounded-all, has-no-error-handling |
| `lucid/load-questions` | exits-without-return-status, has-unbounded-all, has-no-error-handling |
| `qualification-category/seed-category` | exits-without-return-status, has-unbounded-all, has-no-error-handling |
| `qualification-category/seed-questions` | exits-without-return-status, has-unbounded-all, has-no-error-handling |
| `referral/assign` | has-unbounded-all, has-no-error-handling, uses-output-via-echo |
| `update-survey-duration/index` | exits-without-return-status, has-unbounded-all, has-no-error-handling |
| `util/ps-referrer-transactions` | exits-without-return-status, has-unbounded-all, has-no-error-handling |
| `build/index` | exits-without-return-status, has-no-error-handling |
| `cint-sync/balance` | exits-without-return-status, has-no-error-handling |
| `cint-sync/delete-banned` | exits-without-return-status, has-no-error-handling |

## 9. analyze_phpstan_baseline

### N6 — PHPStan baseline triage  *(12 ms)*

- baseline_file: `phpstan-baseline.neon`
- total_ignored: **4232**
- total_files: **682**
- quick_wins: **338** files with ≤3 errors

**Top 15 files by error count:**

| path | count |
|---|---:|
| models/User.php | 107 |
| modules/manage/views/panel/_form.php | 84 |
| components/deviceatlas/DeviceAtlasCloudClient.php | 76 |
| modules/manage/models/search/UserSearch.php | 62 |
| models/Panel.php | 54 |
| components/services/PayPalService.php | 51 |
| modules/manage/models/search/SurveyStatusNpsSearch.php | 45 |
| models/forms/RegistrationForm.php | 42 |
| modules/api/models/Panelist.php | 42 |
| modules/tgmapi/models/ProfileSimple.php | 38 |
| modules/manage/views/site/form/difference.php | 37 |
| models/Alias.php | 35 |
| modules/manage/models/search/RewardSearch.php | 34 |
| controllers/RegistrationController.php | 32 |
| modules/manage/views/message/_form.php | 31 |

**Top categories:**

| category | count |
|---|---:|
| `iterable-no-value-type` | 936 |
| `no-return-type` | 724 |
| `other` | 706 |
| `possibly-undefined-variable` | 544 |
| `no-type-specified` | 516 |
| `no-parameter-type` | 442 |
| `undefined-property` | 169 |
| `return-type-mismatch` | 87 |
| `undefined-method` | 25 |
| `unreachable-statement` | 20 |
| `cannot-access` | 15 |
| `method-on-null` | 14 |
| `unused-symbol` | 11 |
| `strict-comparison` | 10 |
| `phpdoc-unresolvable` | 7 |

## 10. php_security_scan (extended catalog)

### php_security_scan — 20 patterns  *(309 ms)*

- checks_run: **20**
- total_findings: **105**

**By severity:**

| severity | count |
|---|---:|
| critical | 15 |
| high | 64 |
| medium | 25 |
| low | 1 |

**Top patterns:**

| pattern | count |
|---|---:|
| `yii-no-row-level-locking` | 39 |
| `yii-unbounded-all` | 25 |
| `raw-query-yii` | 12 |
| `yii-csrf-disabled` | 12 |
| `exec-php` | 6 |
| `yii-config-hardcoded-secret` | 5 |
| `yii-debug-mode-prod` | 4 |
| `yii-raw-sql-where` | 1 |
| `yii-rbac-cached-permission` | 1 |

## 11. find_php_views (extended)

### find_php_views — render mapping + layouts + widgets + bundles  *(57 ms)*

- mappings: **96** render→view edges
- layouts: **9** ($this->layout assignments)
- widgets: **4** widget references
- asset_bundles: **0** AssetBundle::register sites

**Render kinds:**

| kind | count |
|---|---:|
| full | 92 |
| ajax | 4 |

**Top widgets used:**

| widget | count |
|---|---:|
| Select2 | 2 |
| Alert | 2 |

## 12. php_project_audit (compound)

### php_project_audit — 10 gates  *(1621 ms)*

- duration: 1621 ms
- health_score: **10 / 100**
- total_findings: **591**

**Gate status:**

| gate | status | findings | duration_ms |
|---|---|---:|---:|
| security | ok | 105 | 1440 |
| activerecord | ok | 295 | 385 |
| complexity | ok | 178 | 689 |
| dead_code | ok | 100 | 1620 |
| patterns | ok | 12 | 118 |
| clones | ok | 50 | 1179 |
| hotspots | ok | 1 | 1217 |
| n_plus_one | ok | 100 | 390 |
| god_model | ok | 1 | 643 |
| yii_performance | ok | 44 | 1230 |

**Top risks:** complexity: 178 findings; security: 105 findings; dead_code: 100 findings

---

**Total smoke run time: 4480 ms**

All 12 tool entry points executed successfully against the live
tgm-panel codebase. Numbers above are starting points for the next
audit cycle, not finished findings — each tool's output is intended
to feed into a domain expert review (security audit, perf audit,
RBAC review, etc).
OpenAI API error 400: {
  "error": {
    "message": "Invalid 'input[82]': maximum input length is 8192 tokens.",
    "type": "invalid_request_error",
    "param": null,
    "code": null
  }
}
[codesift] Chunk embedding failed for local/tgmdev-tgm-panel-1428ca602529: OpenAI API error: 400
