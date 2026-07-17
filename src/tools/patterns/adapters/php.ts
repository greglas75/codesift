import type { BuiltinPatternDefinition } from "../types.js";

export const PHP_PATTERNS: Record<string, BuiltinPatternDefinition> = {
  "sql-injection-php": {
    regex: /\$_(?:GET|POST|REQUEST)\[[^\]]+\][\s\S]{0,200}?(?:->query\(|->execute\(|createCommand\()/,
    description: "User input from $_GET/$_POST flowing into SQL query without sanitization (PHP)",
  },
  "xss-php": {
    regex: /echo\s+\$_(?:GET|POST|REQUEST)\[|print\s+\$_(?:GET|POST|REQUEST)\[/,
    description: "Unescaped user input echoed to output — XSS risk (PHP). Use htmlspecialchars()",
  },
  "eval-php": {
    regex: /\beval\s*\(/,
    description: "eval() usage — code injection risk (PHP)",
  },
  "exec-php": {
    regex: /\b(?:exec|system|passthru|shell_exec|popen|proc_open)\s*\(/,
    description: "Shell command execution — command injection risk (PHP)",
  },
  "unserialize-php": {
    regex: /\bunserialize\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)/,
    description: "unserialize() on user input — deserialization attack risk (PHP)",
  },
  "file-include-var": {
    regex: /(?:require|include)(?:_once)?\s*\(?\s*\$(?!this)/,
    description: "require/include with variable — file inclusion risk (PHP)",
  },
  "unescaped-yii-view": {
    regex: /<\?=\s*\$(?!this->(?:render|beginBlock|endBlock))(?!.*?Html::encode)/,
    description: "Yii2 view outputs variable without Html::encode() — XSS risk",
  },
  "raw-query-yii": {
    regex: /createCommand\s*\(\s*["'][^"']*\$\{?\w+/,
    description: "Yii2 createCommand with string interpolation — SQL injection risk",
  },
  // --- Yii2 / PHP additional security & quality patterns (Sprint 2) ---
  "yii-csrf-disabled": {
    // Property assignment OR rule override that disables CSRF on a controller.
    // Common false positive: test-only configs intentionally disable CSRF.
    // We exclude config/test*.php at the search-pattern level via fileIncludePattern.
    regex: /\benableCsrfValidation\s*=\s*false\b/,
    description:
      "CSRF validation explicitly disabled on a controller — accepts forged requests for state-changing actions (Yii2)",
    fileIncludePattern: /\.php$/,
  },
  "yii-debug-mode-prod": {
    // Hard-coded `define('YII_DEBUG', true)` in web/index.php is a deploy
    // disaster — full stack traces leak into production HTTP responses.
    // The pattern intentionally matches both `define()` and `defined() and`
    // forms, since both are legal Yii2 entry-point styles.
    regex:
      /\b(?:define|defined)\s*\(\s*['"]YII_DEBUG['"][^)]*(?:,\s*true|\)\s*(?:and|&&)\s*YII_DEBUG\s*===?\s*true)/,
    description:
      "YII_DEBUG enabled — leaks full stack traces, file paths, and variable contents in HTTP responses (Yii2)",
  },
  "yii-cookie-no-validation": {
    // Empty / placeholder cookie validation key disables HMAC integrity on
    // signed cookies. Matches blank string or obvious placeholder values.
    regex:
      /['"]cookieValidationKey['"]\s*=>\s*['"](?:|change[-_]?me|TODO|xxx+|FIXME|placeholder|insert[-_]?key)['"]/i,
    description:
      "cookieValidationKey is empty or placeholder — signed cookies have no HMAC integrity check (Yii2)",
  },
  "yii-mass-assignment-unsafe": {
    // ->setAttributes($_POST) / ->setAttributes($request->post()) — usually
    // unsafe unless paired with safeAttributes()/scenarios(). We can't tell
    // statically that the class has scenarios(); flag as MEDIUM and let the
    // reviewer make the call.
    regex:
      /->setAttributes\s*\(\s*(?:\$_(?:POST|GET|REQUEST)\b|Yii::\$app->request->(?:post|get)\(\s*\))/,
    description:
      "setAttributes() called with raw user input — bypasses scenarios() guards if not paired with safeAttributes (Yii2)",
  },
  "yii-raw-sql-where": {
    // ActiveQuery->where("col = $var") — string interpolation in WHERE.
    // Matches both single and double quotes. Yii2 supports param-binding
    // via array form `['=', 'col', $var]` which is the safe alternative.
    regex: /->where\s*\(\s*["'][^"']*\$\{?[a-zA-Z_]/,
    description:
      "ActiveQuery->where() with string concatenation — bypasses Yii2 parameter binding (Yii2 SQL injection risk)",
  },
  "php-md5-password": {
    // md5/sha1 applied to anything that smells like a password/secret.
    // High false-positive risk on legitimate hash use; severity HIGH because
    // when it IS a password hash it's a CVE-class bug.
    regex:
      /\b(?:md5|sha1)\s*\(\s*\$(?:password|hasl|haslo|pwd|pass|secret|token|hash)\b/i,
    description:
      "md5() or sha1() used on password/secret — both are broken for password hashing. Use password_hash() / Yii::\\$app->security->generatePasswordHash() (PHP)",
  },
  "php-rand-token": {
    // rand() / mt_rand() / uniqid() on a variable named like a token/secret.
    regex:
      /\$(?:token|nonce|csrf|secret|api[_-]?key|reset[_-]?key)\s*=\s*(?:rand|mt_rand|uniqid)\s*\(/i,
    description:
      "rand()/mt_rand()/uniqid() used to generate token/secret — not cryptographically secure. Use random_bytes() / Yii::\\$app->security->generateRandomString() (PHP)",
  },
  "php-loose-comparison-secret": {
    // == on hash/token comparison — timing attack. Very narrow regex;
    // requires explicit variable naming.
    regex:
      /\b(?:==|!=)\s*\$(?:hash|token|signature|hmac|expected[_-]?hash|secret)\b|\$(?:hash|token|signature|hmac)\s*(?:==|!=)\s*[\$"']/i,
    description:
      "Loose comparison on secret/hash/token — timing-attack vulnerable. Use hash_equals() (PHP)",
  },
  "yii-rbac-cached-permission": {
    // ->can() inside a foreach loop — DbManager hits the DB per call site,
    // O(n) DB roundtrips on a list view. Match foreach + ->can within a
    // bounded window so we don't false-flag unrelated calls in long files.
    regex: /\bforeach\s*\([^{]*\{[\s\S]{0,800}?->can\s*\(/,
    description:
      "->can() called inside foreach — Yii2 DbManager hits the DB per call. Cache permissions or use checkAccess() once outside the loop (Yii2)",
  },
  "yii-no-row-level-locking": {
    // beginTransaction in the same function as findOne/find()->one()
    // without ->forUpdate() — concurrency bug in incentive/payment flows.
    // Bounded window prevents false positives on long methods that legitimately
    // separate the transaction from the read.
    regex:
      /->beginTransaction\s*\(\s*\)[\s\S]{0,1500}?(?:::findOne\s*\(|->one\s*\(\s*\))(?![\s\S]{0,200}->forUpdate\b)/,
    description:
      "Transaction reads a row without SELECT FOR UPDATE — concurrent writers can race and produce duplicate state mutations (Yii2)",
  },
  "yii-config-hardcoded-secret": {
    // Hardcoded literal in 'cookieValidationKey' / 'apiKey' / 'jwtSecret'.
    // Hex/base64 strings of >=20 chars are strong signal. We allow common
    // env() / getenv() lookups as escape hatch.
    regex:
      /['"](?:cookieValidationKey|apiKey|jwtSecret|secretKey|app[_-]?secret|stripe[_-]?secret)['"]\s*=>\s*['"][A-Za-z0-9+\/_=-]{20,}['"]/,
    description:
      "Hardcoded secret in config array — should come from env var or runtime/config-local.php that is gitignored (Yii2)",
  },
  "yii-unbounded-all": {
    // Find()-builder ending in ->all() inside a console controller. We can't
    // easily restrict via path in regex, so use file include pattern. The
    // pattern matches any `find()...all()` chain that doesn't use ->limit().
    regex: /::find\s*\([^)]*\)[\s\S]{0,400}?->all\s*\(\s*\)(?![\s\S]{0,100}->limit\b)/,
    description:
      "ActiveQuery->all() without ->limit() — loads the entire result set into memory. Use ->batch()/->each() for cron/console flows (Yii2 perf)",
    fileIncludePattern: /(?:commands|console)\/[^/]+Controller\.php$/,
  },
  // --- Sprint 7 perf patterns (sourced from tgm-panel performance-audit findings) ---
  "yii-translate-in-loop": {
    // Yii::t() inside a foreach. Costly when paired with DbMessageSource and
    // no message cache (which IS the tgm-panel perf-audit P1 finding). 800-char
    // window after the foreach captures typical loop bodies; nested loops
    // matched separately by global /g.
    regex: /\bforeach\s*\([^{]*\{[\s\S]{0,800}?\\?\bYii::t\s*\(/,
    description:
      "Yii::t() inside foreach — expensive when DbMessageSource caching is off. Move translation outside the loop OR enable enableCaching on the message source (Yii2 perf)",
  },
  "yii-dbtarget-info-level": {
    // DbTarget log target with 'levels' including info/trace/profile.
    // Writes setting often left from local dev; writes to DB on every
    // request hits hard at scale. Bounded window captures the array.
    regex:
      /['"]class['"]\s*=>\s*['"][^'"]*DbTarget['"][\s\S]{0,400}?['"]levels['"]\s*=>\s*\[[^\]]*\b(?:info|trace|profile)\b/,
    description:
      "DbTarget logging info/trace/profile to DB on every request — moves the logger off the hot path (Yii2 perf)",
  },
  "yii-find-with-large-then-filter": {
    // ->find()->all() followed by `array_filter` / `array_map` on the result —
    // pull-then-filter pattern that should be ->where()->all() instead.
    regex: /->find\s*\([^)]*\)[\s\S]{0,200}?->all\s*\(\s*\)\s*;\s*[^\n]{0,200}?\barray_(?:filter|map)\s*\(/,
    description:
      "ActiveQuery->all() into array_filter/array_map — push the filter into the WHERE clause to reduce I/O (Yii2 perf)",
  },
  "yii-cache-no-ttl": {
    // Yii::$app->cache->set('key', $value)  — no TTL argument means cache
    // entry persists indefinitely. Often the deliberate choice, but on
    // user-keyed caches it's a memory bomb.
    regex: /\\?\bYii::\$app->cache->set\s*\(\s*[^,]+,\s*[^,)]+\)/,
    description:
      "cache->set without TTL — entry persists indefinitely. Add a third TTL argument unless caching a global config value (Yii2 perf)",
  },
  "yii-no-batch-on-large": {
    // Same as yii-unbounded-all but applies to non-controller files (services,
    // jobs/, components/). Together they cover 95% of unbounded reads.
    regex: /::find\s*\([^)]*\)[\s\S]{0,400}?->all\s*\(\s*\)(?![\s\S]{0,100}->(?:limit|batch|each)\b)/,
    description:
      "find()->all() in service/job code without ->limit() / ->batch() / ->each() — risk of OOM on growing tables (Yii2 perf)",
    fileIncludePattern: /(?:components|services|jobs|workers|tasks)\/[^/]+\.php$/,
  },
};
