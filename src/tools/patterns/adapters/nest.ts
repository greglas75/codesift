import type { BuiltinPatternDefinition } from "../types.js";

export const NEST_PATTERNS: Record<string, BuiltinPatternDefinition> = {
  "nest-circular-inject": {
    regex: /@Inject\s*\(\s*forwardRef\s*\(/,
    description: "Circular dependency via forwardRef — restructure module boundaries (NestJS)",
  },
  "nest-catch-all-filter": {
    regex: /@Catch\s*\(\s*\)/,
    description: "@Catch() with no argument — catches all exceptions indiscriminately (NestJS)",
  },
  "nest-request-scope": {
    regex: /scope:\s*Scope\.REQUEST/,
    description: "Request-scoped provider — performance overhead, breaks singleton assumptions (NestJS)",
  },
  "nest-raw-exception": {
    regex: /throw\s+new\s+Error\s*\(/,
    description: "Raw Error thrown instead of NestJS HttpException/BadRequestException (NestJS)",
  },
  "nest-any-guard-return": {
    regex: /canActivate[\s\S]{0,100}return\s+true\s*;/,
    description: "Guard always returns true — security no-op (NestJS)",
  },
  "nest-service-locator": {
    regex: /moduleRef\s*\.\s*(?:get|resolve)\s*\(/,
    description: "Service locator via ModuleRef.get/resolve — use constructor injection instead (NestJS)",
  },
  "nest-direct-env": {
    regex: /process\.env\.\w+/,
    description: "Direct process.env access — use ConfigService for type-safe config (NestJS)",
  },
  // Wave 2 anti-patterns
  "nest-graphql-no-auth": {
    // R-7 fix: restrict to .resolver.ts files (via fileIncludePattern) to avoid
    // false positives on REST @Query() params. Regex checks for @Resolver + @Query/@Mutation
    // present AND no @UseGuards anywhere in the matched span (capped at 2000 chars to avoid
    // catastrophic backtracking — O(n) since the negation only runs once per symbol source).
    regex: /^(?![\s\S]*@UseGuards)[\s\S]*@Resolver\s*\([\s\S]{0,500}?@(?:Query|Mutation)\s*\(/,
    description: "GraphQL resolver with @Query/@Mutation but no @UseGuards in file — likely unprotected (NestJS)",
    fileIncludePattern: /\.resolver\.[jt]sx?$/,
  },
  "nest-eager-relation": {
    regex: /@(?:OneToMany|ManyToOne|OneToOne|ManyToMany)\s*\(\s*\(\)\s*=>\s*\w+[\s\S]{0,200}\beager:\s*true/,
    description: "TypeORM relation with { eager: true } — auto-loads joins on every query (NestJS)",
  },
  // Wave 3: nestjs-doctor rule parity batch (15 rules)
  // --- Security (5 rules) ---
  "nest-typeorm-synchronize-prod": {
    regex: /synchronize:\s*true(?![\s\S]{0,100}NODE_ENV\s*!==\s*['"`]production)/,
    description: "TypeORM synchronize: true — schema auto-sync in production drops/recreates tables (NestJS)",
    fileIncludePattern: /\.(ts|js)$/,
  },
  "nest-exposed-stack-trace": {
    regex: /\.stack\s*(?:,|\)|\}|\n)/,
    description: "Error.stack exposed in response/log — leaks internal paths and line numbers (NestJS security)",
    fileIncludePattern: /\.(controller|filter|interceptor)\.[jt]sx?$/,
  },
  "nest-raw-entity-response": {
    regex: /return\s+(?:await\s+)?this\.\w+Repository\.find/,
    description: "Raw entity returned from controller — bypasses @Exclude/@Transform, leaks internal fields (NestJS)",
    fileIncludePattern: /\.controller\.[jt]sx?$/,
  },
  "nest-cors-wildcard": {
    regex: /(?:cors:\s*(?:true|\{\s*origin:\s*['"`]\*['"`])|enableCors\s*\(\s*\{\s*origin:\s*['"`]\*['"`])/,
    description: "CORS wildcard origin — allows any site to make credentialed requests (NestJS security)",
  },
  "nest-disabled-csrf": {
    regex: /csrf:\s*false|csrfProtection.*disabled/i,
    description: "CSRF protection disabled — forms vulnerable to cross-site request forgery (NestJS)",
  },
  // --- Correctness (5 rules) ---
  "nest-missing-guard-method": {
    regex: /implements\s+(?:Can(?:Activate|Load)|NestGuard)(?:\s*\{(?![\s\S]{0,500}(?:canActivate|canLoad)\s*\())/,
    description: "Guard class implements CanActivate/CanLoad but missing the required method (NestJS)",
    fileIncludePattern: /\.guard\.[jt]sx?$/,
  },
  "nest-missing-pipe-transform": {
    regex: /implements\s+PipeTransform(?:\s*\{(?![\s\S]{0,500}transform\s*\())/,
    description: "Pipe class implements PipeTransform but missing transform() method (NestJS)",
    fileIncludePattern: /\.pipe\.[jt]sx?$/,
  },
  "nest-missing-filter-catch": {
    regex: /implements\s+ExceptionFilter(?:\s*\{(?![\s\S]{0,500}catch\s*\())/,
    description: "Exception filter class implements ExceptionFilter but missing catch() method (NestJS)",
    fileIncludePattern: /\.filter\.[jt]sx?$/,
  },
  "nest-missing-interceptor-intercept": {
    regex: /implements\s+NestInterceptor(?:\s*\{(?![\s\S]{0,500}intercept\s*\())/,
    description: "Interceptor class implements NestInterceptor but missing intercept() method (NestJS)",
    fileIncludePattern: /\.interceptor\.[jt]sx?$/,
  },
  "nest-param-decorator-no-type": {
    regex: /@Param\s*\(\s*['"`]\w+['"`]\s*\)\s*\w+\s*[,)]/,
    description: "@Param('id') parameter without type annotation — `id` inferred as `any` (NestJS)",
    fileIncludePattern: /\.controller\.[jt]sx?$/,
  },
  // --- Architecture (3 rules) ---
  "nest-orm-in-controller": {
    regex: /(?:@InjectRepository|this\.\w+Repository\.(?:find|save|update|delete|remove))/,
    description: "Direct ORM/Repository usage in controller — violates separation of concerns (NestJS)",
    fileIncludePattern: /\.controller\.[jt]sx?$/,
  },
  "nest-business-logic-in-controller": {
    regex: /\bif\s*\(\s*\w+\s*\.\s*\w+\s*(?:===|!==|>|<|>=|<=)[\s\S]{0,200}(?:throw\s+new|await\s+this\.)/,
    description: "Complex branching + async call in controller — business logic belongs in a service (NestJS)",
    fileIncludePattern: /\.controller\.[jt]sx?$/,
  },
  "nest-moduleref-get": {
    regex: /\bmoduleRef\s*\.\s*(?:get|resolve)\s*\(\s*['"`]?\w+/,
    description: "Service locator via ModuleRef.get/resolve — use constructor injection instead (NestJS)",
  },
  // --- Performance (2 rules) ---
  "nest-sync-fs-in-handler": {
    regex: /\b(?:readFileSync|writeFileSync|existsSync|statSync|mkdirSync)\s*\(/,
    description: "Synchronous filesystem call blocks the event loop — use fs/promises (NestJS)",
    fileIncludePattern: /\.(controller|service)\.[jt]sx?$/,
  },
  "nest-require-primary-key": {
    regex: /@Entity\s*\([\s\S]{0,200}(?:export\s+)?class\s+\w+(?:\s+extends\s+\w+)?\s*\{(?![\s\S]{0,500}@Primary(?:Generated)?Column)/,
    description: "@Entity without @PrimaryColumn/@PrimaryGeneratedColumn — TypeORM will fail at runtime (NestJS)",
    fileIncludePattern: /\.entity\.[jt]sx?$/,
  },
};
