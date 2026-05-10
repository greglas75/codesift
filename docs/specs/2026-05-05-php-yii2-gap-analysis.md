# PHP / Yii2 Implementation — Gap Analysis (rev 3)

Date: 2026-05-05
Author: codesift core
Status: draft for review (not yet a plan/spec)

> **Re-scope (rev 2):** wcześniejsza wersja sugerowała, że problemem jest adopcja toolów (0 wywołań w usage.jsonl). To był fałszywy sygnał — zespół Grega pracuje na PHP codziennie, manifesty skili zostały już rozszerzone i toole są wywoływane.
>
> **Walidacja (rev 3):** analiza została zwalidowana na drugim, niezależnym Yii2 codebase: `Portal & Access/tgmdev-tgm-panel-1428ca602529`. Codebase zawiera **1882 plików PHP / 17 582 symboli / 11 modułów / 379 migracji / 99 modeli / 20+ console commands** + istniejące audity codesift z 2026-04-19 (db + performance). Sygnały z tych audytów dodały 4 nowe rekomendacje (sekcja 9).

---

## 1. Najmocniejsze ustalenie: structural gap w extractorze

`src/parser/extractors/php.ts` (403 LOC) handluje wszystkie podstawowe nody (namespace, class, interface, trait, enum, function, method, property, const, enum_case) — tu nie ma luk poziomu 1. Ale w porównaniu z extraktorami TS i Python, **PHP gubi metadane na poziomie pojedynczego symbolu**:

| Metadana                                      | TS extractor | Python extractor | PHP extractor          |
|-----------------------------------------------|:------------:|:----------------:|:----------------------:|
| `extends` (base class names)                  | ✓            | ✓                | **✗** (tylko isTestCase regex w docstring lookup) |
| `implements`                                  | ✓            | n/a              | **✗**                  |
| trait `use` (composition)                     | n/a          | n/a              | **✗**                  |
| visibility (public/private/protected)         | n/a          | n/a              | **✗** (skip-only przy docstring lookup) |
| modyfikatory: `static`, `abstract`, `final`, `readonly` | częściowo | n/a       | **✗**                  |
| typed properties (PHP 7.4+, `private string $foo`) | n/a    | n/a              | **✗** (tylko jako tekst w `source`) |
| promoted constructor params (PHP 8.0+)        | n/a          | n/a              | **✗**                  |
| `attribute_list` (PHP 8.0+, `#[Route('/')]`)  | dekoratory ✓ | dekoratory ✓     | **✗** (skip-only)      |
| `is_async`                                    | ✓            | ✓                | n/a (PHP nie ma)       |

**Konsekwencja praktyczna** — każde miejsce, gdzie tool potrzebuje znać "czy to ActiveRecord", "czy controller dziedziczy po `yii\rest\Controller`", "jakie behaviors klasa miksuje", musi wracać do regex na `s.source`:

- `php-tools.ts:131` — `analyzeActiveRecord` regex `/extends\s+(?:ActiveRecord|Model|\\yii\\db\\ActiveRecord)/`
- `php-tools.ts:299` — `findPhpViews` heuristic `s.name.endsWith("Controller")` zamiast `extends "Controller"`
- `route-tools.ts:687` — Yii2 routing identycznie polega na nazwie klasy, nie na hierarchii
- `analyzeActiveRecord:198` — behaviors wykrywane przez `/([A-Z]\w+Behavior)(?:::class)?/` w surowym tekście

To jest **single-point fix**: dodanie 3 pól do extractora (`extends`, `implements`, `meta.uses_traits`) oraz 1 pola dla modyfikatorów (`meta.modifiers`) odblokowuje strukturalne checki w 4 istniejących toolach + każdy nowy tool, który je doda.

### 1.1 Co konkretnie dodać do `php.ts`

**class_declaration / interface_declaration / trait_declaration:**
```ts
const baseClause = node.childForFieldName("base_clause");
const implementsClause = node.childForFieldName("class_interface_clause");
const extendsList = parseBaseClause(baseClause);          // ["yii\\db\\ActiveRecord"]
const implementsList = parseInterfaceClause(implementsClause); // ["JsonSerializable"]
const useTraits = collectTraitUses(body);                 // ["TimestampBehavior trait"]

const sym = makeSymbol(node, name, kind, filePath, source, repo, {
  parentId,
  docstring,
  extends: extendsList,
  implements: implementsList,
  meta: {
    ...modifiers,                 // { abstract?: true, final?: true, readonly?: true }
    uses_traits: useTraits,
    attributes: parseAttributes(node),  // [{ name: "Route", args: ["/api"] }]
  },
});
```

**method_declaration / property_declaration:**
- visibility z `visibility_modifier` child
- `meta.is_static`, `meta.is_abstract`, `meta.is_final`, `meta.is_readonly`
- `meta.return_type` (już w signature, ale chcemy structured)
- `meta.parameter_types` — sparowane z nazwami
- `meta.attributes` — PHP 8 attributes na metodzie/property

**constructor promoted params** — to jest paskudny edge case ale potrzebny:
```php
public function __construct(
    public readonly string $name,    // <-- nowa property, nie złapana przez property_declaration
    private LoggerInterface $log,
) {}
```
Tree-sitter widzi te parametry pod `simple_parameter` w `formal_parameters`. Nasz walker pomija je. Trzeba w `method_declaration` (gdy `name === "__construct"`) iterować parametry z `visibility_modifier` i emitować je jako dodatkowe `field` symbole pod parent klasą.

**attribute_list:**
- użycie `Attribute` w nowoczesnym kodzie eksploduje (Symfony 6+, Doctrine ORM Attributes, Laravel attributes)
- Yii2 sam ich nie ma (jeszcze), ale Yii3 ma — i w Mobi mogą być w bibliotekach 3rd party
- aktualnie kompletnie ignorowane (`getDocstring` tylko skipuje je przy szukaniu komentarza)

**Szacunkowy koszt:** 100-150 LOC w extractorze + ~30 testów w `tests/parser/php-extractor.test.ts`. To jest najwyższy ROI w całej liście.

---

## 2. Pochodne luk extractora w istniejących toolach

Po dodaniu `extends`/`implements`/`uses_traits` do symboli, każdy z tych toolów dostaje porządną redukcję false-positive/negative:

### 2.1 `analyzeActiveRecord` (`php-tools.ts:110`)
**Aktualnie:** regex `/extends\s+(?:ActiveRecord|Model|\\yii\\db\\ActiveRecord)/` na `cls.source`.

**Problemy:**
- nie łapie pośredniego dziedziczenia (`extends BaseUser` gdzie `BaseUser extends ActiveRecord`)
- łapie błędnie `extends Model` z dowolnego `Model` (nie tylko `yii\base\Model`)
- gubi modele z `extends` w innym pliku przez aliased use (`use yii\db\ActiveRecord as AR; class X extends AR`)

**Po fixie:**
- użyj `s.extends` jako struktury, połącz z `use_aliases` (per-file mapa aliasów z import-graph) → resolve do FQCN
- chodź po grafie dziedziczenia (`extends` → znajdź symbol → jego `extends` → ...) z cap depth 5 — tylko wtedy klasyfikujesz "to jest AR"
- analogicznie dla "to jest Yii2 Controller" (`yii\web\Controller` lub jakikolwiek descendant)

### 2.2 `behaviors` extraction
**Aktualnie:** `/([A-Z]\w+Behavior)(?:::class)?/g` na surowym body metody `behaviors()`.

**Problemy:**
- regex wpada na komentarze, na nazwy zmiennych, na klasy które kończą się "Behavior" ale nie są behaviors (false-positive na referencji)
- nie odróżnia behaviors zarejestrowanych vs tylko wymienionych w docu
- gubi behaviors aliased (`use TimestampBehavior as TS; ... 'class' => TS::class`)

**Po fixie:**
Parsuj method body przez tree-sitter. Każdy element wracanej tablicy o kształcie `'name' => ['class' => X::class, ...]` lub `'name' => X::class` — wyciągnij. Resolve `X` przez per-file use-table.

### 2.3 `find_php_views` (`php-tools.ts:288`)
**Aktualnie:** `s.name.endsWith("Controller")` jako filtr.

**Problemy:**
- działa, ale nie wykryje controllerów które nie kończą się na `Controller` (rzadkie, ale są custom routery)
- nie obsługuje:
  - `$this->layout = '@app/views/layouts/main'` (custom layout)
  - `$this->view->render(...)` (alternatywna ścieżka)
  - `$this->renderPartial()` na wskazanej ścieżce z prefiksem path-alias `@app/...`
  - controllerów Yii2 modułowych (mają `viewPath` override)

**Co dodać:**
- pre-pass: dla każdego controllera zbierz `$this->layout`, `controller->viewPath` (z `getViewPath()` override), prefix-path-aliasy z config
- output o kształcie `{ controller, action, render_call: { method, view_name }, resolved_path, layout, partials, widgets }`

### 2.4 `find_php_n_plus_one` (`php-tools.ts:523`)
**Aktualnie:** dobrze przemyślane 3 patterny + scalar-blocklist + getter blocklist.

**Brakuje (rosnąca priorytetem):**
1. **Pattern 4 — `findOne`/`findBy`/`findAll` w pętli** (klasyczny lazy-load):
   ```php
   foreach ($ids as $id) { $u = User::findOne($id); ... }
   ```
   Łatwy regex: `/foreach[^{]*\{[^}]*::find(One|All|ByCondition|BySql)\s*\(/s`
2. **Pattern 5 — relation access **w widoku** (`views/**/*.php`):**
   to jest realny N+1 w Yii2 — render listy modeli + `$model->author->name` w foreach. Aktualnie tool skanuje tylko `kind === "method"`, więc widoki (które zazwyczaj są na poziomie module-level kodu) wypadają.
3. **Pattern 6 — `provider->getModels()` z `DataProvider` bez `with`:**
   `ActiveDataProvider` ma `query` z opcjonalnym `with`. Trzeba sięgnąć do konstruktora DataProvider w controllerze i sprawdzić czy `query->with(...)` jest wywołane.

**False-positive risk dla 1:** funkcje pomocnicze typu `Tag::findOne(['name' => $tag])` gdy `$ids` to stała 5-elementowa lista — to nie jest realny N+1. Akceptowalny — to discovery tool.

### 2.5 `find_php_god_model` (`php-tools.ts:654`)
Aktualnie OK. Dodatkowo warto:
- klasyfikacja "AR z >5 relacjami **bez** żadnego `behaviors`" → kandydat do refaktoru (stara prosta encja, dorobić TimestampBehavior/SoftDeleteBehavior)
- "klasa `*Service` z >40 metodami i bez interfejsu" → "service klasa do split"

To wymaga `extends`/`implements` z extractora (G1) + heurystyki nazewniczej.

### 2.6 `php_security_scan` — patterny do dodania

Aktualnie **8 wzorców** (4 generic PHP, 2 Yii2-specific, 2 generic). Realnie brakujące, najczęstsze CVE patterny w Yii2 audytach:

| Pattern (proponowana nazwa)        | Severity | Wykrywa                                                                |
|------------------------------------|----------|------------------------------------------------------------------------|
| `yii-mass-assignment-unsafe`       | high     | `$model->setAttributes($_POST)` lub `$model->load(...)` na klasie bez `safeAttributes()`/`scenarios()` lub bez `rules()` (ostrożnie — dużo FP, używać tylko jako MEDIUM) |
| `yii-csrf-disabled`                | high     | `enableCsrfValidation = false` w controllerze (w `behaviors()` lub property) bez wyłącznie API base class |
| `yii-access-control-missing`       | medium   | Controller (ne-AR class extends Controller) bez `behaviors()` z `AccessControl` ani per-action `Yii::$app->user->can(...)` |
| `yii-debug-mode-prod`              | critical | `defined('YII_DEBUG') and YII_DEBUG === true` w `index.php` env-prod (sprawdzaj po `web/index.php`) |
| `yii-cookie-no-validation`         | high     | `'cookieValidationKey' => ''` lub literał `'cookieValidationKey' => '...'` z hardcodowanym kluczem |
| `yii-rbac-cached-permission`       | medium   | `Yii::$app->user->can(...)` w pętli/foreach (każde wywołanie hituje DB w DbManager) |
| `php-md5-password`                 | high     | `md5(` lub `sha1(` na zmiennej `password`/`hasło` (use `Yii::$app->security->generatePasswordHash`) |
| `php-rand-token`                   | high     | `rand()`, `mt_rand()`, `uniqid()` używane do generowania tokenów (use `Yii::$app->security->generateRandomString`) |
| `php-loose-comparison-secret`      | medium   | `==` na hashach/tokenach (timing attack, use `hash_equals`) |
| `yii-raw-sql-via-where`            | high     | `->where("col = $var")` (string concat in where), nawet z bindings — często FP, ale warto flagować |

**Wszystkie da się napisać jako pattern-tools regex** — nic nie wymaga AST. Koszt: ~50 LOC w `pattern-tools.ts` + 10 testów w `php-security-scan.test.ts`.

### 2.7 `resolve_php_service` (`php-tools.ts:348`)
**Aktualnie:** parsuje `config/(web|console|main|db).php` szuka `'name' => ['class' => 'FQCN']`.

**Brakuje:**
1. **moduły:** każdy moduł ma `getComponents()` lub `components` w konfigu, np. `modules.review.components.notifier`. Aktualny regex tego nie zobaczy.
2. **DI container:** `Yii::$container->set(InterfaceName::class, ImplName::class)` — często w `bootstrap()` lub w `config/web.php` w sekcji `container.singletons`. Aktualny regex łapie tylko `class` literally w pierwszym poziomie.
3. **Yii2 Application properties** — `'name' => 'Mobi'`, `'language' => 'en-US'` — nie chcemy ich, ale aktualny regex je przyjmuje (false-positive: spróbuje rozwiązać `'Mobi'` jako klasę).
4. **closures:** `'mailer' => function() { return new Mailer(); }` — ten przypadek dziś po prostu nie matchuje, więc wypada — ale powinien być flagowany jako "component zdefiniowany przez factory, nie da się zresolwować statycznie".

### 2.8 `tracePhpEvent` (`php-tools.ts:220`)
**Aktualnie:** regex `->trigger('name')` + `(->|::)on('name', ...)`.

**Brakuje:**
1. **class const event names** — Yii2 idiom: `class User extends AR { const EVENT_AFTER_LOGIN = 'afterLogin'; }`, potem `Event::on(User::class, User::EVENT_AFTER_LOGIN, ...)`. Aktualny regex widzi tylko literały. Trzeba pre-pass: zbuduj mapę `ClassName::CONST_NAME → 'string-value'` z `const_declaration` w PHP, potem przy match użyj jej.
2. **bare `Event::on`** — sklejamy z global namespace. OK obsługiwane.
3. **`->off(...)` / detach** — dla pełnego obrazu cyklu życia listenera.

---

## 3. Brakujące Yii2 koncepcje (nowe toole — proponowany ranking ROI)

### N1 — `analyze_yii_modules` (HIGH ROI)
**Czego brakuje:** Mobi ma `modules/*`, każdy moduł to klasa rozszerzająca `yii\base\Module`. Posiada własny `controllerNamespace`, własne komponenty, własne migrations, sub-modules. Obecnie narzędzia widzą controllery jako luźny zbiór, bez przypisania do modułu, bez mapy URL prefix → moduł.

**Output:**
```ts
{
  modules: Array<{
    name: string;                    // "review"
    file: string;                    // "modules/review/Module.php"
    controllerNamespace: string;     // "app\\modules\\review\\controllers"
    controllers: Array<ControllerRef>;
    submodules: string[];
    components: ServiceRef[];        // module-scoped components
    migrations_path: string | null;  // "modules/review/migrations"
    url_prefix: string;              // resolved from main config urlManager
  }>;
}
```

**Zależności:** wymaga G1 (extends w extractorze) żeby wykryć `extends Module` poprawnie.

**Zwrot:** odblokuje per-module routing (G2), pozwoli na cross-link "która część kodu należy do modułu X" w innych toolach (god-model, security scan).

### N2 — `analyze_yii_migrations` (HIGH ROI, 0-day konkurencji)
**Czego brakuje:** Yii2 migrations są w PHP DSL, nie w SQL. Aktualnie `migration_lint` jest auto-loaded dla composer.json, ale parsuje tylko `.sql`. To jest dziura.

**Co tool robi:**
- Znajdź wszystkie pliki `migrations/m\d+_\d+_*.php` (i `modules/*/migrations/`)
- Klasy `extends Migration` → ekstraktuj `safeUp()` / `up()` body
- Mapuj DSL na strukturalny shape:
  - `$this->createTable('users', [...])` → `{ op: "create_table", name: "users", columns: [...] }`
  - `$this->addColumn(...)` → `{ op: "add_column", ... }`
  - `$this->createIndex(...)` → `{ op: "create_index", ... }`
  - `$this->addForeignKey(...)` → `{ op: "add_fk", ... }`
- Audyty:
  - brak `safeDown` / `down` (nieodwracalna migration)
  - `addForeignKey` bez wcześniejszego `createIndex` na tej kolumnie (slow FK lookups)
  - `dropTable` / `dropColumn` bez backupu (ostrzeżenie operacyjne)
  - `alterColumn` zmiana NOT NULL na kolumnie z istniejącymi danymi (potential data loss)
  - timestamp ordering: czy nazwy plików są monotoniczne

**Defensible:** żaden konkurent nie parsuje Yii2 PHP-DSL migrations strukturalnie. To samo applikuje się do Laravel migrations (klasa `extends Migration` z `up()/down()`) — tool z minimalnym refaktorem zacznie wspierać oba.

### N3 — `analyze_yii_rbac` (MEDIUM-HIGH ROI)
**Czego brakuje:** Yii2 RBAC to zazwyczaj kombinacja:
- `auth->createRole/createPermission/add/addChild` w `RbacController` lub seederze
- `Yii::$app->user->can('permission')` w controllerach/widgetach
- `AccessControl` w `behaviors()` z listą ról/permission

**Output:**
```ts
{
  permissions_defined: string[];     // wszystko z auth->createPermission
  roles_defined: string[];
  permissions_checked: Array<{ name: string; file: string; line: number }>;
  orphan_checks: string[];           // sprawdzane, nie zdefiniowane
  unused_definitions: string[];      // zdefiniowane, nigdy nie sprawdzane
  controllers_without_access_control: Array<{ class: string; file: string }>;
}
```

**Zwrot:** jeden output zastąpi godzinną manualną analizę dla każdego nowego klienta. RBAC orphans to top finding w 100% Yii2 audytów.

### N4 — `analyze_yii_console_commands` (LOW-MEDIUM ROI)
**Czego brakuje:** Console controllery (zazwyczaj `console/controllers/*Controller.php` lub `commands/*Command.php`) są często cron jobs — i są często źle pokryte testami / nie mają error handlingu. Aktualnie traktowane jak zwykłe controllery.

**Output:**
- lista console commands + actions
- argumenty (z `actionFoo(string $arg)` signature → CLI argv mapping)
- czy są referowane w cron config (sprawdź w `crontab`-like file lub w `SystemCron` jeśli Mobi ma własną tabelę)

**Wartość:** bardziej niche niż N1-N3, ale Mobi ma sporo cronów (`SurveyAutoPauseScheduler` w usage.jsonl).

### N5 — `analyze_yii_widgets_and_assets` (LOW ROI)
**Czego brakuje:** GridView/ActiveForm/Pjax/Panel + AssetBundle — dla audytów performance i bundle-bloat.

**Sceptyczny — odraczam.** Realnie Mobi pewnie ma swoje custom widgets i asset bundles, ale dotyczy to małej części pracy. Można później.

---

## 4. Lista patternów do dodania w `pattern-tools.ts` (mniej narzędzi, niższy koszt)

Niezależnie od decyzji o nowych toolach, te patterny mają wysokie ROI bo dodają się do `php_security_scan` przez prosty wpis w `PHP_SECURITY_CHECKS`:

```
yii-csrf-disabled         (high)     — false-flag CSRF w controllerze
yii-debug-mode-prod       (critical) — YII_DEBUG=true w web/index.php
yii-cookie-no-validation  (high)     — pusta cookieValidationKey
yii-mass-assignment-unsafe(medium)   — ->setAttributes($_POST/$_GET) bez scenarios
yii-raw-sql-where         (high)     — ->where("$var") string concat
php-md5-password          (high)     — md5($password)
php-rand-token            (high)     — rand()/uniqid() na tokeny
php-loose-comparison-secret (medium) — == na hash/token
yii-rbac-cached-permission (low)     — ->can() w foreach
```

Razem z istniejącymi 8 → 17 wzorców. Koszt: 1 plik patternów + tabela severity, ~80 LOC.

---

## 5. Drobne defekty do pociągnięcia przy okazji

| Lokalizacja | Defekt |
|-------------|--------|
| `php-tools.ts:131` | Regex matchuje `extends Model` dla dowolnej klasy `Model` z dowolnego namespace — false-positive na non-Yii2 model classes (np. modele Twigowe lub własne base klasy). Po fixie extractora: structural match na FQCN. |
| `php-tools.ts:189` | `rules()` parser regex `\[\s*\[?['"]?[\w,\s'"]+['"]?\]?\s*,\s*['"]([\w]+)['"]` — łapie tylko nazwę walidatora, gubi pola których dotyczy. Audyty potrzebują `{ fields: [...], validator: "required" }`. |
| `php-tools.ts:248` | `->trigger('name')` regex nie obsługuje `Class::trigger(...)` (statyczny trigger w niektórych Yii2 modulach). |
| `php-tools.ts:317` | `views/{ctrl}/{view}.php` — convention-only, nie zna path aliasów (`@app/views/...`). Trzeba czytać `Yii::$container->setAliases` z config + heurystyka. |
| `php-tools.ts:357` | `componentRe` — pierwszy match wygrywa. Komponent zdefiniowany dwa razy (raz w `web.php`, raz w `params-local.php`) — drugi jest gubiony. |
| `php.ts:131` | `isTestCaseClass` szuka `TestCase` w base_clause — gubi Codeception (`extends \Codeception\Test\Unit`, `extends Cest`, `extends Cept`). |

---

## 6. Rekomendowana sekwencja prac

### Sprint 1 (1-2 dni) — extractor structural fix (G1)
**To jest fundament dla wszystkiego innego.** Bez tego każdy nowy tool jest skazany na regex.

1. `php.ts` — dodaj `extends`, `implements`, `meta.uses_traits`, `meta.modifiers`, `meta.attributes`, `meta.visibility`, `meta.is_static`
2. Promoted constructor params jako `field` symbole
3. Codeception base class detection w `isTestCaseClass`
4. Bump `EXTRACTOR_VERSIONS.php` (force reindex)
5. Testy w `tests/parser/php-extractor.test.ts` (~30 nowych)

### Sprint 2 (1 dzień) — patterny security
1. 9 nowych wpisów w `pattern-tools.ts` PHP_SECURITY_CHECKS
2. Aktualizacja `php_security_scan` checks list
3. Testy w `tests/tools/php-security-scan.test.ts`

### Sprint 3 (2-3 dni) — fixy istniejących toolów
1. `analyzeActiveRecord` — używaj `s.extends` strukturalnie + use-table aliases + walk hierarchy
2. `behaviors()` parser — tree-sitter zamiast regex
3. `tracePhpEvent` — class const event-name resolution
4. `resolvePhpService` — moduły + DI container + closures + dedup
5. `findPhpNPlusOne` — pattern 4 (findOne in loop) + pattern 5 (views)

### Sprint 4 (3-5 dni) — N1 + N2 (modules + migrations)
Najwyższe ROI z nowych toolów. N1 wymaga skończonego G1.

### Sprint 5 (3-5 dni) — N3 (RBAC)
Wymaga ukończonego N1 (per-module access control checks).

### Sprint 6 (opcjonalnie) — N4 console commands

---

## 7. Z czego rezygnujemy / co odraczamy

- **G4 (routing/discovery boost):** wycofane — zespół już używa skili z manifestami. Adopcja nie jest blokerem.
- **PHPStan/Psalm bridge** (analog `run_ruff`): wartościowe, ale to drugi tier — najpierw structural fundament.
- **composer.lock supply-chain:** odroczone — `dependency_audit` zna tylko npm/pip, dorobienie composer to osobny projekt.
- **Yii2 advanced template detection** (frontend/backend/common/console): nice-to-have, ale Mobi nie używa advanced template (z usage.jsonl widać `models/`, `modules/`, `components/`, `config/` na głównym poziomie — to basic template).
- **Twig/Smarty:** out of scope. Mobi używa native PHP views.

---

## 8. Pytania otwarte

1. Czy zespół Grega używa Yii2 RBAC w Mobi 2? Jeśli tak — N3 leci wcześniej. Jeśli ma własną tabelę permissions — tool musi to detektować. **(Walidacja w tgm-panel: TAK — używają `Yii::$app->authManager` przez dektrium/yii2-rbac, permissions seedowane w migrations. N3 jest priorytetem.)**
2. Czy są już migracje w `modules/*/migrations/`? Jeśli tak — N2 musi obsłużyć multi-path discovery od początku.
3. Czy Mobi 2 ma config-split (`params-local.php`, `web-local.php`)? Jeśli tak — `resolvePhpService` musi merge'ować, nie tylko czytać główny plik.
4. Czy chcesz osobny `analyze_codeception` (analog `get_test_fixtures`) czy wystarczy fix w `isTestCaseClass`? **(Walidacja w tgm-panel: 3 suites — `tgmapi`, `u`, `unit` z osobnymi `*.suite.yml`. Sam fix `isTestCaseClass` to za mało; suite-level mapping ma realny ROI.)**

---

## 9. Walidacja na drugim codebase: tgm-panel

> Druga niezależna instancja Yii2. Dane bezpośrednio waliduj/aktualizują rekomendacje wyżej.

### 9.1 Sygnały twardo potwierdzające istniejące rekomendacje

| Rekomendacja | Walidacja w tgm-panel |
|---|---|
| **G1** (extends w extractorze) | `models/User.php`: `class User extends BaseUser` gdzie `use dektrium\user\models\User as BaseUser`. Aktualny regex `/extends\s+(?:ActiveRecord\|Model)/` **nie złapie** tego User.php → User nie zostanie zidentyfikowany jako AR mimo że nim jest. To dokładnie problem z sekcji 1.1. |
| **G1** modules detection | `modules/api/Module.php`: `class Module extends \yii\base\Module` (FQCN inline). Bez structural `extends` w extractorze, N1 nie znajdzie żadnego z 11 modułów. |
| **N1 modules** | **11 modułów** w tgm-panel: `api`, `events`, `lucid2`, `lucidMonetization`, `manage`, `manageApi`, `panelistGuard`, `payments`, `reports`, `tgmapi`, `verifier`. Każdy z własnym `Module.php`, `controllers/`, `models/`, część z `jobs/`, `views/`, `assets/`, `components/`. Bez N1 audyty traktują to jako luźny zbiór. |
| **N2 migrations** | **379 migracji** w PHP DSL. Sample (`m180504_110045_verificationCodes`): klasyczny `extends Migration` + `$this->createTable(...)` + `$this->createIndex(...)`. Db-audit znalazł **100+ `dropColumn`/`alterColumn`** bez ALGORITHM/LOCK hint — to dokładnie przykład gdzie N2 dawałoby wartość. |
| **N3 RBAC** | Codebase używa `Yii::$app->authManager` (dektrium/yii2-rbac jako provider). Permissions seedowane w migrations: `m180803_154046_create_permissions`, `m180927_105323_panel_221_permissions`, `m220119_102306_add_help_desk_permissions`, `m240213_124524_*`, `m240530_215244_*` — czyli 5+ migracji wzbogaca graf RBAC. **N3 musi parsować zarówno migrations jak i runtime checks**, bo nazwy permissions są często dynamiczne (`$auth->createPermission($permissionName)` z `$permissionName` przekazywanym z konfigu migracji). |
| **N4 console commands** | **20+ commands** w `commands/*Controller.php` (Cint, Lucid, Mailer, Push, Report, Sync, ...). Wszystkie obecnie traktowane jak zwykłe controllery. |
| **Codeception fix** | `codeception.yml` + 3 suites (`tgmapi.suite.yml`, `u.suite.yml`, `unit.suite.yml`) + `_bootstrap.php` + `_data` + `_output` + `_support` — pełna struktura. Klasy `extends Codeception\Test\Unit` / `extends Cest`. |

### 9.2 Obserwacje, które zmieniają priorytety

**O1 — PHP 8 features ROI ZMIENIA SIĘ W ZWIĄZKU Z PLANOWANĄ MIGRACJĄ NA PHP 8 (rev 3, korekta po feedbacku Grega).**

Stan obecny w tgm-panel: 0 wystąpień `#[Attribute]`, 0 `readonly`, 0 promoted constructor params, 0 typed properties. `composer.json` wymaga `php >=7.2.0`. Codebase trzymany defensywnie w PHP 7.2 stylu.

**Ale:** Greg potwierdził że **migracja na PHP 8 jest planowana**. To zmienia 2 rzeczy:
1. Extractor **musi obsługiwać PHP 8 syntax od dnia merge'a migracji** — inaczej każda nowa klasa pisana w PHP 8 stylu (typed props, promoted ctor, readonly, attributes) będzie miała pustą metadaną i wszystkie audity będą zwracały false-negatives.
2. Pojawia się **nowa kategoria toolów: migration-assist** — flagowanie miejsc w kodzie, które po migracji powinny zostać przepisane na PHP 8 idiom. Te toole mają wartość **tylko w oknie migracji** (kilka miesięcy), ale w tym oknie ich ROI jest bardzo wysoki.

**Konsekwencja dla planu:** wszystkie PHP 8 metadane wracają do **Sprint 1** razem z `extends`/`implements`. Migration-assist toole stają się osobnym Sprint 2.5 (przed N1/N2, żeby zespół miał je gotowe na czas migracji).

**Zaktualizowane P-poziomy dla extractora:**
- **Sprint 1 (P0):** `extends`, `implements`, `uses_traits`, `meta.modifiers` (visibility/static/abstract/final), **typed properties** (PHP 7.4+), **`@var` parser na propertach**, **`#[Attribute]` extraction** (PHP 8.0+), **`readonly` modifier** (PHP 8.1+), **promoted constructor params jako synthetic field symbols** (PHP 8.0+), **`enum` cases z backed type** (PHP 8.1+)
- **Sprint 2 (P0):** patterny security (sekcja 4)
- **Sprint 2.5 (P1, NOWY):** PHP 8 migration-assist toole (sekcja 9.2.1 niżej)

### 9.2.1 Nowe rekomendacje: PHP 8 migration-assist toolset

Te toole pomagają w samej migracji 7.2 → 8.x. Wartość czasowa, ale duża **w oknie migracji**.

**M1 — `find_php8_migration_candidates`** (compound tool, ~5 sub-checks)

Skanuje codebase i flaguje miejsca, które po przejściu na PHP 8 powinny zostać przepisane na nowoczesny idiom. Każdy finding ma confidence + suggested transformation (ale nie auto-fix — tylko podpowiedź).

| Sub-check | Wykrywa | Sugerowana transformacja |
|---|---|---|
| `promotable-ctor` | `__construct` z N parametrami, gdzie każdy parametr `$x` jest **bez modyfikacji** przypisany do `$this->x = $x` (gdzie property `$x` jest zadeklarowana w klasie z `@var T` lub bez typu) | Skompresuj do PHP 8.0 promoted ctor: `public function __construct(public T $x) {}`. Usuń jawne property declarations + przypisania w body. |
| `docblock-to-typed-property` | `/** @var T */` nad property bez typu inline | Przekonwertuj na PHP 7.4 typed property: `public T $x;`. Pozostaw `@var` jeśli docblock dodaje informację o nullowości / kolekcji elementów (`@var int[]` zostaje). |
| `nullable-flag-to-syntax` | `@var T\|null` na property | `public ?T $x;` |
| `readonly-candidate` | Property zadeklarowana, ustawiana **tylko w `__construct`** w całym pliku, brak settera, brak `unset` | `public readonly T $x;` (PHP 8.1+). Wymaga cross-method analysis w obrębie klasy + skan wszystkich klas dziedziczących. |
| `enum-from-class-consts` | Klasa z N stałymi `const FOO = 'foo'` + statyczna metoda `getValues()`/`getOptions()` (klasyczny pre-enum idiom, używany m.in. w yii2mod/yii2-enum który jest w composer.json tgm-panel) | Konwertuj na PHP 8.1 backed enum: `enum X: string { case Foo = 'foo'; }`. Bardzo prawdopodobny w `app\models\enums\*` które są w User.php. |
| `match-from-switch` | `switch ($x) { case ...: return Y; }` gdzie każdy `case` zwraca i nie ma fall-through | `match($x) { … }` (cleaner, value-returning). Niski priorytet ale tani check. |

**Sygnał z tgm-panel:** `models/User.php` importuje 8+ enumów (`use app\models\enums\AdvQueryParamsEnum;`, `RespondentActionEnum`, `UserSettingsEnum`, `DemographicEnum`, ...). Każdy z nich to kandydat dla `enum-from-class-consts`. Mass-conversion w jednym sprincie po migracji = duża wartość.

**M2 — `find_php8_attribute_candidates`** (rev 3 — Yii3 migration potwierdzona w planach Grega, P0)

Greg potwierdził że migracja na Yii3 jest możliwa równolegle z PHP 8. To zmienia M2 z opcjonalnego na **must-have** w Sprint 2.5. Yii3 jest natywnie PHP 8 attributes-based — bez tej konwersji codebase nie ruszy.

Tool sugeruje miejsca gdzie array-config idiom Yii2 mógłby zostać zastąpiony attributes:

| Wzorzec Yii2 | Wzorzec Yii3 (attribute) |
|---|---|
| `behaviors() { return ['timestamp' => ['class' => TimestampBehavior::class, 'attributes' => [...]]] }` | `#[Behavior(TimestampBehavior::class, attributes: [...])]` na klasie |
| `rules() { return [['email', 'required'], ['email', 'email']] }` | `#[Required, Email]` na property |
| `scenarios()` z field lists | `#[Scenario('create', fields: [...])]` per metodę / property |
| `actions() { return ['index' => ['class' => ListAction::class]] }` | `#[Action(ListAction::class)]` na metodę |
| `urlManager` rules: `'GET api/users/<id>' => 'user/view'` | `#[Route(method: 'GET', path: '/api/users/{id}')]` na controller action |
| `actionParams()` | parametry w sygnaturze + auto-binding (Yii3 hydrator) |

**Wartość:** dla każdego znalezionego AR / Controller wygeneruj proposed transformation. Format output:
```ts
{
  candidates: Array<{
    file, class, transformation: "behaviors-to-attributes" | "rules-to-attributes" | ...,
    current_snippet, proposed_snippet,
    confidence: "high" | "medium" | "low",
    blockers: string[]  // np. ["dynamic class name in array"], ["nested closure in rules"]
  }>
}
```

### M4 — `yii3_migration_audit` (NOWY, P0 Sprint 2.5)

Sam M2 (attributes) to tylko czubek góry lodowej Yii3. Realna migracja wymaga **inwentaryzacji wszystkich Yii2-specific API**, które w Yii3 mają inne nazwy lub w ogóle znikają. To jest bardzo bolesny manual audit (tysiące call sites) — automatyzacja daje ogromną wartość.

**Co tool inwentaryzuje (per-category, z surowym count + file:line):**

| Kategoria | Yii2 API | Yii3 zmiana | Ryzyko |
|---|---|---|---|
| Service Locator | `Yii::$app->X` (X = `db`, `user`, `cache`, `mailer`, `urlManager`, `request`, `response`, ...) | Zniknął `Yii::$app` → DI container injection przez ctor | **CRITICAL** — każde wywołanie wymaga refactoru |
| Object factory | `Yii::createObject($config)` | Zniknął → `Container::get(Class::class)` | HIGH |
| Aliases | `Yii::getAlias('@app')`, `Yii::setAlias(...)` | Aliases service jako DI | HIGH |
| i18n | `Yii::t('app', 'msg')` | `TranslatorInterface` injection | HIGH |
| Logger | `Yii::error()`, `Yii::info()`, `Yii::warning()` | PSR-3 logger injection | HIGH |
| Application | `\Yii::$app->id`, `params`, `language`, `homeUrl` | Application config service | MEDIUM |
| Module | `extends \yii\base\Module` z `controllerNamespace` | Yii3 nie ma modules core — packagize lub flatten | **CRITICAL** dla 11 modułów w tgm-panel |
| Request | `Yii::$app->request->post()`, `->get()`, `->isPost` | PSR-7 `ServerRequestInterface` injection | HIGH |
| Response | `Yii::$app->response->redirect(...)` | PSR-7 `ResponseFactoryInterface` | HIGH |
| Session | `Yii::$app->session->get/set/setFlash` | Yii Session package, injection | MEDIUM |
| User identity | `Yii::$app->user->identity`, `->id`, `->isGuest`, `->can()` | Yii Auth package + RBAC package | HIGH |
| ActiveRecord | `extends ActiveRecord` z `tableName()`, `rules()`, `scenarios()`, `behaviors()` | Yii3 nie ma AR core — Cycle ORM lub Yii ActiveRecord package | **CRITICAL** dla 99 modeli w tgm-panel |
| Validator | `[['email'], 'required']` w `rules()` | Yii Validator package, attribute-based | HIGH |
| Forms | `extends Model` z `rules()` + `load()` + `validate()` | Yii FormModel package | HIGH |
| Widgets | `GridView::widget(...)`, `ActiveForm::begin()` | Yii Widgets — pakiety osobno, część zniknęła | HIGH |
| View | `$this->render('view', $params)`, `$this->layout` | Yii View package, inny lifecycle | HIGH |
| URL Manager | `Yii::$app->urlManager->createUrl([...])` + `urlManager` rules | Yii Router package + attribute routes (M2) | HIGH |
| Console | `extends \yii\console\Controller` z `actionX($arg)` | Yii Console — Symfony Console-like API | HIGH |
| Migrations | `extends Migration` z `safeUp/safeDown` | Yii Db Migration package, podobne API | LOW (najmniej bolesne) |
| Queue | `yii\queue\amqp_interop` | Yii Queue package | MEDIUM |
| RBAC | `Yii::$app->authManager->createPermission/add/addChild` | Yii RBAC package — różne API | HIGH |

**Output (per-codebase summary):**
```ts
{
  total_yii2_api_calls: number,                  // np. 12 487
  by_category: Record<Category, {
    count: number,
    severity: "critical" | "high" | "medium" | "low",
    sample_files: Array<{ file, line, snippet }>,
    estimated_effort_per_call: "trivial" | "small" | "medium" | "large",
  }>,
  blockers: Array<{
    category: string,
    reason: string,        // np. "Module class is core architectural choice; flattening 11 modules requires structural redesign"
    related_files_count: number,
  }>,
  effort_estimate: { hours_low: number, hours_high: number },
  migration_phases_suggested: Array<{
    phase: string,         // np. "Phase 1: AR removal (replace with Cycle ORM or Yii AR pkg)"
    blocks_phase: string[],
    estimated_hours: { low: number, high: number },
  }>,
}
```

**Wartość z perspektywy planning'u:** to jest **decision-support tool**. Zarząd / CTO patrzy na liczby (12 487 call sites do `Yii::$app`, 99 ActiveRecord models, 11 modułów) i podejmuje decyzję czy:
- (a) iść w pełną migrację na Yii3 (estimate w godzinach × stawka),
- (b) zostać na Yii 2.0.49+ z PHP 8 (Sprint 2.5 dostarcza wszystko czego potrzeba),
- (c) zrobić hybrydę: nowe moduły jako Yii3 microservices, legacy zostaje na Yii 2.0.49+.

**Bez tego toola** decyzja jest podejmowana "na czuja" — typowo skutkuje to estimacjami które rozjeżdżają się z rzeczywistością o 3-5x. CodeSift jako single-source-of-truth dla tej liczby jest **defensible niche** (żaden konkurent nie ma ani CLI inwentaryzacji Yii2 API).

**Koszt M4:** 250-350 LOC + 21 kategorii grep patterns. ~3 dni dev. Wartość — uzasadnia cały Sprint 2.5.

### Aktualizacja Sprint 2.5 (rev 3 z Yii3)

Sprint 2.5 staje się centralnym punktem migration toolset:
- **M3** — pre-flight compat (PHP 8 only, blokuje merge)
- **M1** — modernization candidates (PHP 8 idiom)
- **M2** — attribute conversion candidates (Yii3 path)
- **M4** — Yii3 migration audit (decision support)

**Czas Sprint 2.5: 5-6 dni** (z 3-4 dni). Cały sprint poświęcony migracjom.

**Sugerowany flow użycia toolset przez zespół Grega:**
1. **M4** odpalany pierwszy — daje liczby do decyzji "Yii2.0.49 czy Yii3"
2. Jeśli decyzja Yii3 → **M3** odpalany przed merge'em PHP 8 (gating)
3. Po PHP 8 merge → **M1** flaguje co modernizować
4. Równolegle z Yii3 migration → **M2** flaguje konwersje attributes per moduł

**M3 — `php_version_compat_check`** (must-have przed merge'em migracji)

Pre-flight check przed merge'em migracji 7.2 → 8.x. Skanuje codebase pod kątem **breaking changes** PHP 8.0/8.1/8.2:

- `each()` (removed in 8.0) — brak w nowoczesnych codebasach, ale legacy może zostać
- `create_function()` (removed in 8.0)
- `(real)` cast (removed in 8.0)
- `mbstring.func_overload` config (removed in 8.0)
- `errorHandler` callable z 1 argumentem (od 8.0 wymaga 2)
- `array_key_exists` na obiekcie (deprecated w 7.4, removed w 8.0)
- `is_resource` na zamkniętych connection objects (zmiana semantyki)
- `null` na string parameters w funkcjach core (8.1: deprecated; 9.0: error) — to jest **gigantyczna kategoria** (np. `strpos($haystack, null)`)
- `dynamic property creation` (deprecated w 8.2 bez `#[AllowDynamicProperties]`) — bardzo bolesne dla Yii2, gdzie ActiveRecord polega na `__set`/`__get`
- `utf8_encode`/`utf8_decode` (deprecated w 8.2)
- `Yii2 2.0.17` ma znane bugi pod PHP 8 — flaguj jeśli detect — i przypomnij że zespół powinien bumpować do 2.0.49+ przed/razem z PHP 8

**Output:**
```ts
{
  total_breaking: number,
  by_severity: { breaking_8_0: N, deprecated_8_1: N, deprecated_8_2: N },
  by_pattern: Record<string, Array<{ file, line, snippet }>>,
  blocker_for_merge: Array<...>,  // breaking 8.0 stuff
  pre_merge_todos: Array<...>,
  yii_version_warning: string | null,  // jeśli Yii < 2.0.49 i PHP 8
}
```

**Priorytet M3:** **najwyższy z trzech** — to gating tool przed mergem migracji. Bez tego team merguje "na ślepo" i potem łapie runtime errors w produkcji. **Sprint 2.5 P0.**

**Priorytet M1:** Sprint 2.5 P0/P1 (po M3 — najpierw upewnij się że nic nie pęknie, potem dopiero modernizuj idiom).

**Priorytet M2:** opcjonalny, czekać na decyzję czy będzie też migracja na Yii3.

### 9.2.2 Korekta planowania w Sprint 1

Co dodaje się do Sprint 1 z powodu PHP 8 (versus rev 2):
- typed properties extraction (`property_promotion_modifier` + type hint w `property_declaration`)
- `readonly` modifier flag w meta
- attributes ekstrakcja (`attribute_list` → `meta.attributes: Array<{ name, args }>`)
- promoted ctor params → emit jako synthetic `field` symbols z `meta.from_constructor: true`
- backed enum support (już mamy `enum_declaration` ale nie wyciągamy `: string` / `: int` typu)

**Szacunkowy koszt Sprint 1 (zaktualizowany):** 200-280 LOC w extractorze + ~50 testów. Z 1.5-2 dni → **3-4 dni**. Nadal najwyższe ROI.

**O2 — PHPDoc `@var` parser MA WYSOKI ROI.**
Sample z migracji `PortalRegistrationFix`:
```php
/** @var string */
public $portalUserRmsid;

/** @var float */
public $regBonus;

/** @var User */
protected $user;
```

Aktualny `parsePhpDocTags` parsuje **tylko `@property`** (klasowy docblock) i `@method`. **Nie parsuje `@var` na propertach**. To jest 100% utracona informacja typowa w starszych Yii2 codebasach. Dodanie ~10 LOC do `parsePhpDocTags` (regex `/@var\s+(\S+)/`) i wpięcie tego w `property_declaration` walker → pełna mapa typów properties bez wymagania PHP 7.4+.

**Decyzja:** dodać do **Sprint 1**, traktować jako część G1 (cost +20 LOC).

**O3 — Db-audit ujawnia 4 nowe patterny / checks.**

Z `audits/db-audit-2026-04-19.md`:
1. **`yii-no-row-level-locking`** (high) — codebase ma 40+ `beginTransaction` ale **0** wystąpień `FOR UPDATE` / `SKIP LOCKED` / `LOCK IN SHARE`. Real concurrency bug w incentive flows. Pattern: `beginTransaction` w funkcji + `findOne`/`one()` w tej samej funkcji bez `->forUpdate()`.
2. **`yii-migration-no-online-ddl`** (high) — `dropColumn` / `alterColumn` w migration bez wcześniejszego ustawienia `ALGORITHM=INPLACE, LOCK=NONE`. To **pattern w N2**, nie w `php_security_scan`.
3. **`yii-config-hardcoded-secret`** (critical) — literały kluczy w `config/web.php` / `config/main.php` (`'cookieValidationKey' => 'abc...'`, `'apiKey' => 'sk_...'`). Wymaga skanu literałów >20 znaków z high entropy w plikach config.
4. **Migration → table mapping** — migrations używają `VerificationCode::tableName()` (model constant). Bez resolucji tej stałej, N2 nie zbuduje mapy "która migration dotyka której tabeli". To wymaga **constant resolver** w extractorze (już mamy `const_declaration` jako symbole, brakuje tylko query API typu "resolve `Class::CONST_NAME` → wartość").

**Z `audits/performance-audit-2026-04-19.md`:**
5. **`yii-unbounded-all`** (high) — 176× `->all()` vs 6× `->batch()`/`->each()`. Pattern: `find()->...->all()` w pliku `commands/*Controller.php` (cron jobs). Akceptowalny w controllerach z paginacją; problematyczny w cron.
6. **`yii-translate-no-cache`** (medium) — `Yii::t()` w pętli + DbMessageSource bez `enableCaching` (config check). Wymaga cross-file analysis: pętla z `Yii::t()` + config flag.
7. **`yii-dbtarget-on-info-level`** (medium) — `DbTarget` jako log target z `levels => ['info', 'trace', 'profile']` — pisze setki rzędów per request. Config-only check.

**Decyzja:**
- 1, 3 → dodać do listy patternów w sekcji 4.
- 2 → wbudować w N2 (analyze_yii_migrations) jako audit check.
- 4 → osobny mini-tool `resolve_php_constant(repo, fqcn)` lub jako extension API w extractorze (`get_constant_value`). Dodać do Sprint 4 razem z N2.
- 5, 6, 7 → osobna sekcja `yii-perf-patterns` (5 wzorców) → **nowy rozdział nie w `php_security_scan` tylko w `php_project_audit` jako gate `yii_performance`**.

### 9.3 Nowa rekomendacja: N6 — `analyze_phpstan_baseline`

**Kontekst:** tgm-panel ma `phpstan.neon` (level 6) + `phpstan-baseline.neon` o **18 011 liniach** (~1 800 zignorowanych errorów). To realny sygnał: zespół zaadoptował PHPStan, ale ma masę legacy. Aktualny CodeSift nie czyta tego.

**Co tool robi:**
- Parsuje `phpstan-baseline.neon` (NEON jest podzbiorem YAML z 1 specyficzną składnią — biblioteka `js-yaml` z custom resolverem wystarczy)
- Output:
  ```ts
  {
    total_ignored: number,
    by_path: Array<{ path: string; count: number; categories: Record<string, number> }>,
    by_category: Record<string, number>,  // "no return type" → 234, "undefined property" → 89, ...
    quick_wins: Array<{ path: string; count: number }>,  // 1-3 errors per file
    diff_since: { added: number; removed: number },     // jeśli git history
  }
  ```
- Wartość: pokazuje **gdzie zacząć refactor** (quick_wins) i **czy baseline rośnie** (regression signal)

**Defensible:** to jest **uniwersalny PHP tool**, nie tylko Yii2. Zadziała dla każdego repo z PHPStan. Konkurencja (Serena, jCodeMunch, GitNexus) tego nie ma.

**Koszt:** ~150 LOC + NEON parser. Wymaga `composer.json` jako sygnału + obecności `phpstan-baseline.neon`.

**Priorytet:** P1, po N1+N2 (Sprint 4 alt).

### 9.4 Nowa rekomendacja: N7 — `audit_diff` (universal, nie tylko PHP)

**Kontekst:** w tgm-panel są zapisane wcześniejsze audity (`audits/db-audit-2026-04-19.md`, `audits/performance-audit-2026-04-19.md`). Audyty się starzeją. Realna potrzeba: "co zmieniło się od ostatniego audytu — które findings nadal aktywne, które naprawione, które nowe."

**Co tool robi:**
- Wczytuje poprzedni audit markdown (parsuje sekcje `## Findings` z severity tags)
- Re-runuje aktualny audit (`audit_scan` lub `php_project_audit`)
- Diff: NEW / RESOLVED / STILL_ACTIVE / DEGRADED
- Output: zwięzły markdown z delta + "score change since last audit"

**Defensible:** uniwersalny, wartość rośnie z każdym kolejnym audytem.

**Priorytet:** P2, scope całościowy (nie PHP-only). Zostawiam w gap analysis dla świadomości — implementację outsourcować poza ten plan.

### 9.5 Zaktualizowana sekwencja prac (rev 3 — z planowaną migracją PHP 8)

| Sprint | Zadania | Czas |
|---|---|---|
| **1** | G1 extractor pełny: `extends`/`implements`/`uses_traits`/`modifiers` + `@var` parser + **typed properties (PHP 7.4+)** + **promoted ctor (PHP 8.0+)** + **readonly (PHP 8.1+)** + **attributes (PHP 8.0+)** + **backed enum types (PHP 8.1+)** + Codeception base classes | 3-4 dni |
| **2** | 9 nowych patternów security (sekcja 4) + 3 z db-audit (`yii-no-row-level-locking`, `yii-config-hardcoded-secret`, `yii-debug-mode-prod`) | 1-1.5 dnia |
| **2.5** | **Migration toolset (PHP 8 + Yii3):** M3 (`php_version_compat_check`) + M1 (`find_php8_migration_candidates`) + M2 (`find_php8_attribute_candidates` — Yii3 path) + **M4 (`yii3_migration_audit` — decision support tool)** | 5-6 dni |
| **3** | Fixy istniejących toolów (sekcja 2) — używają G1 strukturalnie | 2-3 dni |
| **4** | **N1 (modules) + N2 (migrations)** razem — N2 dostaje migration→table mapping przez resolver constant; N1 dostaje per-module routing | 4-5 dni |
| **5** | **N3 (RBAC)** — parse migrations + runtime checks, orphan/unused detection | 3-4 dni |
| **6** | N6 (`analyze_phpstan_baseline`) + N4 (console commands) — równolegle | 2-3 dni |
| **7** | `php_project_audit` nowy gate `yii_performance` (5 wzorców z perf audit) | 1 dzień |

**Razem: ~4.5 tygodnia pracy dev** (z PHP 8 + Yii3 migration toolset).

**Krytyczna zależność czasowa:**
- **M4 (Yii3 audit)** powinien być gotowy **przed decyzją** "Yii2.0.49 czy Yii3" — bo to ta decyzja gating'uje cały dalszy plan migracji. Sugeruję wypchnąć M4 jako pierwszy z Sprint 2.5 (Sprint 2.5a, 2-3 dni dev solo).
- **Sprint 1** musi być gotowy **przed** mergem PHP 8 do main, inaczej extractor zwraca puste metadane dla nowo pisanych klas → audity dają false-negatives.
- **M3** musi być gotowy **przed** mergem PHP 8 — gating tool dla pre-merge.
- **M1 + M2** mogą lecieć równolegle z migracją (są używane w trakcie i po).

**Sugerowany timing realny:**
- T0 (decyzja o migracji): rozpoczynamy Sprint 1 + M4 równolegle
- T0 + 1 tydzień: M4 ready → decision call (Yii3 vs Yii2.0.49)
- T0 + 2 tygodnie: Sprint 1 ready (extractor PHP 8-aware) + M3 ready
- T0 + 2 tygodnie: zespół zaczyna mergować PHP 8 do main (M3 jako pre-merge gate)
- T0 + 3 tygodnie: M1 + M2 ready (jeśli decyzja Yii3 z poprzedniego call)
- T0 + 4-5 tygodni: reszta sprintów (3-7) — fixy, modules, RBAC, etc.

**Co można zrobić równolegle:**
- Sprint 1 i 2 pełnie niezależne (różni dev / różne pliki)
- Sprint 4 (N1 + N2) wymaga ukończonego Sprint 1
- Sprint 5 (N3) wymaga ukończonego Sprint 4 (per-module RBAC checks)
- Sprint 6 (N4 + N6) niezależny od reszty
- Sprint 7 to drobny add-on, można w dowolnym momencie po Sprint 3
