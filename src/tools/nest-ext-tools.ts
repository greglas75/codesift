/**
 * NestJS extended analysis tools — Wave 2 (G5, G6, G7/G8, G12, G14).
 * Separate file from nest-tools.ts to keep it under the CQ11 soft limit.
 * All tools follow the established regex-over-source pattern with CQ6/CQ8 guarantees.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { detectCycles, type NestToolError } from "./nest-tools.js";

// ---------------------------------------------------------------------------
// G5: nest_graphql_map — GraphQL resolver discovery
// ---------------------------------------------------------------------------

export interface NestGraphQLEntry {
  resolver_class: string;
  file: string;
  operation: "Query" | "Mutation" | "Subscription" | "ResolveField";
  handler: string;
  return_type?: string;
}

export interface NestGraphQLMapResult {
  entries: NestGraphQLEntry[];
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestGraphQLMap(
  repo: string,
  options?: { max_entries?: number },
): Promise<NestGraphQLMapResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const maxEntries = options?.max_entries ?? 300;
  const entries: NestGraphQLEntry[] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  const resolverFiles = index.files.filter(
    (f) => f.path.endsWith(".resolver.ts") || f.path.endsWith(".resolver.js"),
  );

  for (const file of resolverFiles) {
    if (entries.length >= maxEntries) { truncated = true; break; }
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    // Find resolver class name (searches for class declaration near @Resolver decorator)
    const resolverClassMatch = /@Resolver\s*\([\s\S]*?\)\s*(?:export\s+)?class\s+(\w+)/.exec(source);
    const resolverClass = resolverClassMatch?.[1] ?? "UnknownResolver";

    // Extract GraphQL operation decorators with their handler names
    // R-2 fix: cap decorator args to 300 chars to prevent cross-method boundary matching
    const opRe = /@(Query|Mutation|Subscription|ResolveField)\s*\(([\s\S]{0,300}?)\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = opRe.exec(source)) !== null) {
      if (entries.length >= maxEntries) { truncated = true; break; }
      const operation = m[1]! as NestGraphQLEntry["operation"];
      const args = m[2]!;
      const handler = m[3]!;

      // Extract return type from decorator arg: () => Article → Article
      const returnTypeMatch = /\(\s*\)\s*=>\s*(?:\[\s*)?(\w+)/.exec(args);
      const entry: NestGraphQLEntry = {
        resolver_class: resolverClass,
        file: file.path,
        operation,
        handler,
      };
      if (returnTypeMatch) entry.return_type = returnTypeMatch[1]!;
      entries.push(entry);
    }
  }

  return {
    entries,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

// ---------------------------------------------------------------------------
// G6: nest_websocket_map — WebSocket gateway discovery
// ---------------------------------------------------------------------------

export interface NestGatewayEntry {
  gateway_class: string;
  file: string;
  port?: number;
  namespace?: string;
  events: Array<{ event: string; handler: string }>;
}

export interface NestWebSocketMapResult {
  gateways: NestGatewayEntry[];
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestWebSocketMap(
  repo: string,
  options?: { max_gateways?: number },
): Promise<NestWebSocketMapResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const maxGateways = options?.max_gateways ?? 100;
  const gateways: NestGatewayEntry[] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  const gatewayFiles = index.files.filter(
    (f) => f.path.endsWith(".gateway.ts") || f.path.endsWith(".gateway.js"),
  );

  for (const file of gatewayFiles) {
    if (gateways.length >= maxGateways) { truncated = true; break; }
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    // Parse @WebSocketGateway decorator with optional port + options
    // Form 1: @WebSocketGateway()
    // Form 2: @WebSocketGateway(3001)
    // Form 3: @WebSocketGateway(3001, { namespace: '/chat' })
    // Form 4: @WebSocketGateway({ namespace: '/chat' })
    const wsGwRe = /@WebSocketGateway\s*\(([\s\S]*?)\)\s*(?:export\s+)?class\s+(\w+)/;
    const gwMatch = wsGwRe.exec(source);
    if (!gwMatch) continue;

    const gwArgs = gwMatch[1]!;
    const gatewayClass = gwMatch[2]!;

    const entry: NestGatewayEntry = {
      gateway_class: gatewayClass,
      file: file.path,
      events: [],
    };

    // Port — first integer literal in args
    // R-4 fix: only accept a leading bare integer as port (not nums inside namespace strings)
    const portMatch = /^\s*(\d+)\s*(?:,|\))/.exec(gwArgs);
    if (portMatch) entry.port = parseInt(portMatch[1]!, 10);

    // Namespace — from options object
    const nsMatch = /namespace:\s*['"`]([^'"`]+)['"`]/.exec(gwArgs);
    if (nsMatch) entry.namespace = nsMatch[1]!;

    // Find @SubscribeMessage handlers
    const subRe = /@SubscribeMessage\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g;
    let sm: RegExpExecArray | null;
    while ((sm = subRe.exec(source)) !== null) {
      entry.events.push({ event: sm[1]!, handler: sm[2]! });
    }

    gateways.push(entry);
  }

  return {
    gateways,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

// ---------------------------------------------------------------------------
// G7+G8: nest_schedule_map — @Cron/@Interval/@Timeout/@OnEvent discovery
// ---------------------------------------------------------------------------

export interface NestScheduledEntry {
  class_name: string;
  file: string;
  handler: string;
  decorator: "@Cron" | "@Interval" | "@Timeout" | "@OnEvent";
  expression?: string;
  interval_ms?: number;
}

export interface NestScheduleMapResult {
  entries: NestScheduledEntry[];
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestScheduleMap(
  repo: string,
  options?: { max_schedules?: number; max_files_scanned?: number },
): Promise<NestScheduleMapResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const maxSchedules = options?.max_schedules ?? 300;
  const maxFilesScanned = options?.max_files_scanned ?? 2000;
  const entries: NestScheduledEntry[] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  // Pre-filter: only .ts/.js files, exclude spec/test files, prefer .service.ts
  const candidateFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".ts") && !f.path.endsWith(".js")) return false;
    if (/\.(spec|test)\./.test(f.path)) return false;
    if (f.path.includes("/node_modules/")) return false;
    return true;
  });

  let scanned = 0;
  for (const file of candidateFiles) {
    if (scanned >= maxFilesScanned) { truncated = true; break; }
    if (entries.length >= maxSchedules) { truncated = true; break; }
    scanned++;

    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    // Quick substring filter to skip files without schedule/event decorators
    if (!/@Cron|@Interval|@Timeout|@OnEvent/.test(source)) continue;

    // Find enclosing class name — single-class-per-file assumption for simplicity
    const classMatch = /(?:export\s+)?class\s+(\w+)/.exec(source);
    const className = classMatch?.[1] ?? "UnknownClass";

    // Parse each decorator type
    const decoratorPatterns: Array<{
      type: NestScheduledEntry["decorator"];
      regex: RegExp;
      parseArg: (arg: string) => { expression?: string; interval_ms?: number };
    }> = [
      {
        type: "@Cron",
        regex: /@Cron\s*\(\s*['"`]([^'"`]+)['"`][^)]*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g,
        parseArg: (arg) => ({ expression: arg }),
      },
      {
        type: "@Interval",
        regex: /@Interval\s*\(\s*(\d+)\s*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g,
        parseArg: (arg) => ({ interval_ms: parseInt(arg, 10) }),
      },
      {
        type: "@Timeout",
        regex: /@Timeout\s*\(\s*(\d+)\s*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g,
        parseArg: (arg) => ({ interval_ms: parseInt(arg, 10) }),
      },
      {
        type: "@OnEvent",
        regex: /@OnEvent\s*\(\s*['"`]([^'"`]+)['"`][^)]*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g,
        parseArg: (arg) => ({ expression: arg }),
      },
    ];

    for (const { type, regex, parseArg } of decoratorPatterns) {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(source)) !== null) {
        if (entries.length >= maxSchedules) { truncated = true; break; }
        const arg = m[1]!;
        const handler = m[2]!;
        entries.push({
          class_name: className,
          file: file.path,
          handler,
          decorator: type,
          ...parseArg(arg),
        });
      }
    }

    // R-12 fix: fallback — catch constant/expression args like @Cron(CronExpression.EVERY_10_SECONDS)
    // These are not captured by the literal-specific regexes above.
    const fallbackRe = /@(Cron|Interval|Timeout|OnEvent)\s*\(\s*([A-Z][\w.]+)\s*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g;
    let fm: RegExpExecArray | null;
    while ((fm = fallbackRe.exec(source)) !== null) {
      if (entries.length >= maxSchedules) { truncated = true; break; }
      const handler = fm[3]!;
      // Skip if already captured by a literal regex above
      if (entries.some((e) => e.file === file.path && e.handler === handler)) continue;
      entries.push({
        class_name: className,
        file: file.path,
        handler,
        decorator: `@${fm[1]!}` as NestScheduledEntry["decorator"],
        expression: fm[2]!, // raw constant expression, e.g. "CronExpression.EVERY_10_SECONDS"
      });
    }
  }

  return {
    entries,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

// ---------------------------------------------------------------------------
// G12: nest_typeorm_map — TypeORM entity relation graph
// ---------------------------------------------------------------------------

export interface NestEntityNode {
  name: string;
  file: string;
  table?: string;
}

export interface NestEntityEdge {
  from: string;
  to: string;
  relation: "OneToMany" | "ManyToOne" | "OneToOne" | "ManyToMany";
}

export interface NestTypeOrmMapResult {
  entities: NestEntityNode[];
  edges: NestEntityEdge[];
  cycles: string[][];
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestTypeOrmMap(
  repo: string,
  options?: { max_entities?: number },
): Promise<NestTypeOrmMapResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const maxEntities = options?.max_entities ?? 200;
  const entities: NestEntityNode[] = [];
  const edges: NestEntityEdge[] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  const entityFiles = index.files.filter(
    (f) => f.path.endsWith(".entity.ts") || f.path.endsWith(".entity.js"),
  );

  for (const file of entityFiles) {
    if (entities.length >= maxEntities) { truncated = true; break; }
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    // @Entity() or @Entity('table_name') followed by class declaration
    // R-10 fix: also accept object-form @Entity({ name: 'users' }) — capture table from name field
    const entityRe = /@Entity\s*\(\s*(?:['"`]([^'"`]+)['"`]|\{[^}]*\})?\s*\)\s*(?:export\s+)?class\s+(\w+)/g;
    let em: RegExpExecArray | null;
    while ((em = entityRe.exec(source)) !== null) {
      if (entities.length >= maxEntities) { truncated = true; break; }
      let tableName = em[1]; // from string form @Entity('users')
      const entityName = em[2]!;
      // R-10: extract table name from object form @Entity({ name: 'users' })
      if (!tableName) {
        const objNameMatch = em[0].match(/\{\s*[^}]*name:\s*['"`]([^'"`]+)['"`]/);
        if (objNameMatch) tableName = objNameMatch[1]!;
      }
      const node: NestEntityNode = { name: entityName, file: file.path };
      if (tableName) node.table = tableName;
      entities.push(node);

      // Find relations within this entity's class body
      // Scan forward from the class match until the next @Entity or end of file
      const classStart = em.index + em[0].length;
      const nextEntityMatch = /@Entity\s*\(/.exec(source.slice(classStart));
      const classEnd = nextEntityMatch ? classStart + nextEntityMatch.index : source.length;
      const classBody = source.slice(classStart, classEnd);

      const relRe = /@(OneToMany|ManyToOne|OneToOne|ManyToMany)\s*\(\s*\(\)\s*=>\s*(\w+)/g;
      let rm: RegExpExecArray | null;
      while ((rm = relRe.exec(classBody)) !== null) {
        edges.push({ from: entityName, to: rm[2]!, relation: rm[1]! as NestEntityEdge["relation"] });
      }
    }
  }

  // Detect cycles in entity relation graph
  const entityNames = entities.map((e) => e.name);
  const cycles = detectCycles(entityNames, edges.map((e) => ({ from: e.from, to: e.to })));

  return {
    entities,
    edges,
    cycles,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

// ---------------------------------------------------------------------------
// G14: nest_microservice_map — @MessagePattern / @EventPattern discovery
// ---------------------------------------------------------------------------

export interface NestMicroserviceEntry {
  type: "MessagePattern" | "EventPattern";
  pattern: string;
  handler: string;
  controller: string;
  file: string;
}

export interface NestMicroserviceMapResult {
  patterns: NestMicroserviceEntry[];
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestMicroserviceMap(
  repo: string,
  options?: { max_patterns?: number },
): Promise<NestMicroserviceMapResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const maxPatterns = options?.max_patterns ?? 300;
  const patterns: NestMicroserviceEntry[] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  // Microservice patterns are typically in controller files (hybrid apps)
  const controllerFiles = index.files.filter(
    (f) => f.path.endsWith(".controller.ts") || f.path.endsWith(".controller.js"),
  );

  for (const file of controllerFiles) {
    if (patterns.length >= maxPatterns) { truncated = true; break; }
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    // Quick substring filter
    if (!/@(MessagePattern|EventPattern)/.test(source)) continue;

    const classMatch = /class\s+(\w+)/.exec(source);
    const controller = classMatch?.[1] ?? "UnknownController";

    const patternRe = /@(MessagePattern|EventPattern)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\n?\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = patternRe.exec(source)) !== null) {
      if (patterns.length >= maxPatterns) { truncated = true; break; }
      patterns.push({
        type: m[1]! as "MessagePattern" | "EventPattern",
        pattern: m[2]!,
        handler: m[3]!,
        controller,
        file: file.path,
      });
    }
  }

  return {
    patterns,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

// ---------------------------------------------------------------------------
// Wave 3 Feature 2: nest_queue_map — Bull / BullMQ queue processor discovery
// ---------------------------------------------------------------------------

export interface NestQueueProcessor {
  processor_class: string;
  queue_name: string;
  file: string;
  handlers: Array<{
    decorator: "@Process" | "@OnQueueActive" | "@OnQueueCompleted" | "@OnQueueFailed" | "@OnQueueStalled" | "@OnQueueWaiting" | "@OnQueueProgress" | "@OnQueueError";
    handler: string;
    job_name?: string; // For @Process('specific-job')
  }>;
}

export interface NestQueueMapResult {
  processors: NestQueueProcessor[];
  /** Consumers that inject @InjectQueue('name') — producer side */
  producers: Array<{ class_name: string; queue_name: string; file: string }>;
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestQueueMap(
  repo: string,
  options?: { max_processors?: number },
): Promise<NestQueueMapResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const maxProcessors = options?.max_processors ?? 200;
  const processors: NestQueueProcessor[] = [];
  const producers: NestQueueMapResult["producers"] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  // Scan .ts/.js files for @Processor or @InjectQueue decorators
  const candidateFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".ts") && !f.path.endsWith(".js")) return false;
    if (/\.(spec|test)\./.test(f.path)) return false;
    if (f.path.includes("/node_modules/")) return false;
    return true;
  });

  for (const file of candidateFiles) {
    if (processors.length >= maxProcessors) { truncated = true; break; }
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    // Quick substring filter
    if (!/@Processor|@InjectQueue/.test(source)) continue;

    // --- Parse @Processor('queue-name') classes ---
    const procRe = /@Processor\s*\(\s*(?:['"`]([^'"`]+)['"`])?\s*\)\s*(?:export\s+)?class\s+(\w+)/g;
    let pm: RegExpExecArray | null;
    while ((pm = procRe.exec(source)) !== null) {
      if (processors.length >= maxProcessors) { truncated = true; break; }
      const queueName = pm[1] ?? "default";
      const processorClass = pm[2]!;

      // Find the class body (forward scan for @Process handlers)
      const classStart = pm.index + pm[0].length;
      const nextClassMatch = /(?:export\s+)?class\s+\w+/.exec(source.slice(classStart));
      const classEnd = nextClassMatch ? classStart + nextClassMatch.index : source.length;
      const classBody = source.slice(classStart, classEnd);

      const handlers: NestQueueProcessor["handlers"] = [];
      const handlerDecorators: Array<[string, NestQueueProcessor["handlers"][number]["decorator"]]> = [
        ["Process", "@Process"],
        ["OnQueueActive", "@OnQueueActive"],
        ["OnQueueCompleted", "@OnQueueCompleted"],
        ["OnQueueFailed", "@OnQueueFailed"],
        ["OnQueueStalled", "@OnQueueStalled"],
        ["OnQueueWaiting", "@OnQueueWaiting"],
        ["OnQueueProgress", "@OnQueueProgress"],
        ["OnQueueError", "@OnQueueError"],
      ];

      for (const [decName, decType] of handlerDecorators) {
        // Match decorator with optional job name arg, then method name (skip modifiers)
        const re = new RegExp(
          `@${decName}\\s*\\(\\s*(?:['"\`]([^'"\`]+)['"\`])?\\s*\\)\\s*\\n?\\s*(?:(?:public|private|protected|static)\\s+)?(?:async\\s+)?(\\w+)\\s*\\(`,
          "g",
        );
        let hm: RegExpExecArray | null;
        while ((hm = re.exec(classBody)) !== null) {
          const jobName = hm[1];
          const handler = hm[2]!;
          handlers.push({
            decorator: decType,
            handler,
            ...(jobName ? { job_name: jobName } : {}),
          });
        }
      }

      processors.push({
        processor_class: processorClass,
        queue_name: queueName,
        file: file.path,
        handlers,
      });
    }

    // --- Parse @InjectQueue('queue-name') producers ---
    const injectRe = /@InjectQueue\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    let im: RegExpExecArray | null;
    while ((im = injectRe.exec(source)) !== null) {
      const queueName = im[1]!;
      // Find the enclosing class
      const beforeInject = source.slice(0, im.index);
      const lastClass = beforeInject.match(/(?:export\s+)?class\s+(\w+)[\s\S]*$/);
      const className = lastClass ? lastClass[1]! : "UnknownClass";
      producers.push({ class_name: className, queue_name: queueName, file: file.path });
    }
  }

  return {
    processors,
    producers,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

// ---------------------------------------------------------------------------
// Wave 3 Feature 3: nest_scope_audit — Request scope escalation detector
// ---------------------------------------------------------------------------

export interface NestScopeIssue {
  provider: string;
  scope: "REQUEST" | "TRANSIENT";
  file: string;
  /** Transitive callers that become request-scoped by DI bubble-up */
  escalated_consumers: string[];
}

export interface NestScopeAuditResult {
  request_scoped: NestScopeIssue[];
  transient_scoped: NestScopeIssue[];
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestScopeAudit(
  repo: string,
  options?: { max_providers?: number },
): Promise<NestScopeAuditResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const maxProviders = options?.max_providers ?? 200;
  const errors: NestToolError[] = [];
  let truncated = false;

  // First: build a full DI edge map (source → target) across all injectable providers.
  // We need the INVERSE graph: for each request-scoped provider, find all transitive
  // consumers that become implicitly request-scoped.
  interface ProviderInfo {
    name: string;
    file: string;
    scope: "REQUEST" | "TRANSIENT" | "DEFAULT";
  }
  const providers = new Map<string, ProviderInfo>();
  const injectEdges: Array<{ from: string; to: string }> = []; // consumer → injected

  const candidateFiles = index.files.filter((f) => f.path.endsWith(".ts") || f.path.endsWith(".js"));
  for (const file of candidateFiles) {
    if (providers.size >= maxProviders) { truncated = true; break; }
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    if (!/@Injectable/.test(source)) continue;

    // Parse each @Injectable class and capture scope
    const injRe = /@Injectable\s*\(([^)]*)\)\s*(?:export\s+)?class\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = injRe.exec(source)) !== null) {
      const args = m[1] ?? "";
      const name = m[2]!;
      const scopeMatch = args.match(/scope:\s*Scope\.(\w+)/);
      const scope = (scopeMatch?.[1] ?? "DEFAULT") as ProviderInfo["scope"];
      providers.set(name, { name, file: file.path, scope });

      // Extract constructor-injected types (simple regex — reuse existing helper via import would be cleaner)
      const classIdx = source.indexOf(`class ${name}`);
      if (classIdx === -1) continue;
      const classSource = source.slice(classIdx);
      const ctorMatch = /constructor\s*\(([\s\S]*?)\)\s*\{/.exec(classSource);
      if (!ctorMatch) continue;
      const ctorBody = ctorMatch[1]!;
      // Extract type references (match `: TypeName` or generic inner)
      const typeRe = /:\s*(\w+)(?:<\s*(\w+)\s*>)?/g;
      let tm: RegExpExecArray | null;
      while ((tm = typeRe.exec(ctorBody)) !== null) {
        const outer = tm[1]!;
        const inner = tm[2];
        // Container generic (Repository<User>) → use inner
        const target = /^(Repository|Model|Collection|Array|Set|Map|List|Observable|Promise)$/.test(outer) && inner ? inner : outer;
        injectEdges.push({ from: name, to: target });
      }
    }
  }

  // Build reverse index: for each target, who injects it?
  const injectedBy = new Map<string, Set<string>>();
  for (const edge of injectEdges) {
    if (!injectedBy.has(edge.to)) injectedBy.set(edge.to, new Set());
    injectedBy.get(edge.to)!.add(edge.from);
  }

  // For each REQUEST/TRANSIENT provider, walk the reverse graph (BFS) to find all consumers
  const walkConsumers = (startName: string): string[] => {
    const visited = new Set<string>();
    const queue = [startName];
    const consumers: string[] = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const parents = injectedBy.get(cur);
      if (!parents) continue;
      for (const parent of parents) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        consumers.push(parent);
        queue.push(parent);
      }
    }
    return consumers;
  };

  const request_scoped: NestScopeIssue[] = [];
  const transient_scoped: NestScopeIssue[] = [];
  for (const [name, info] of providers) {
    if (info.scope === "REQUEST") {
      request_scoped.push({
        provider: name,
        scope: "REQUEST",
        file: info.file,
        escalated_consumers: walkConsumers(name),
      });
    } else if (info.scope === "TRANSIENT") {
      transient_scoped.push({
        provider: name,
        scope: "TRANSIENT",
        file: info.file,
        escalated_consumers: walkConsumers(name),
      });
    }
  }

  return {
    request_scoped,
    transient_scoped,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

// ---------------------------------------------------------------------------
// Wave 3 Feature 4: nest_openapi_extract — @nestjs/swagger → OpenAPI 3.1
// ---------------------------------------------------------------------------

export interface OpenAPIOperation {
  path: string;
  method: string;
  summary?: string;
  description?: string;
  tags?: string[];
  security?: Array<{ [scheme: string]: string[] }>;
  parameters: Array<{ name: string; in: "path" | "query" | "header"; required: boolean; schema?: { type: string } }>;
  requestBody?: { content: { [mime: string]: { schema: { $ref?: string; type?: string } } } };
  responses: { [statusCode: string]: { description?: string; content?: { [mime: string]: { schema: { $ref?: string } } } } };
}

export interface OpenAPISchema {
  type: "object";
  properties: { [name: string]: { type?: string; $ref?: string; required?: boolean; description?: string; enum?: string[] } };
  required?: string[];
}

export interface NestOpenAPIResult {
  openapi: "3.1.0";
  info: { title: string; version: string };
  paths: { [path: string]: { [method: string]: OpenAPIOperation } };
  components: { schemas: { [name: string]: OpenAPISchema } };
  errors?: NestToolError[];
}

export async function nestOpenAPIExtract(
  repo: string,
  options?: { title?: string; version?: string },
): Promise<NestOpenAPIResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const errors: NestToolError[] = [];
  const paths: NestOpenAPIResult["paths"] = {};
  const schemas: NestOpenAPIResult["components"]["schemas"] = {};

  // Step 1: Extract DTO schemas from files with @ApiProperty decorators
  const allFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".ts") && !f.path.endsWith(".js")) return false;
    if (/\.(spec|test)\./.test(f.path)) return false;
    return true;
  });

  for (const file of allFiles) {
    let source: string;
    try { source = await readFile(join(index.root, file.path), "utf-8"); } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    if (!/@ApiProperty/.test(source)) continue;

    // Parse DTO classes
    const classRe = /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{([\s\S]*?)^\}/gm;
    let cm: RegExpExecArray | null;
    while ((cm = classRe.exec(source)) !== null) {
      const className = cm[1]!;
      const body = cm[2]!;
      if (!/@ApiProperty/.test(body)) continue;

      const schema: OpenAPISchema = { type: "object", properties: {}, required: [] };
      // Match @ApiProperty({ ... }) followed by field: type;
      const propRe = /@ApiProperty(?:Optional)?\s*\(\s*(\{[^}]*\})?\s*\)\s*(?:(?:readonly|public|private)\s+)?(\w+)(\??)\s*:\s*(\w+(?:<[\w,\s]+>)?)/g;
      let pm: RegExpExecArray | null;
      while ((pm = propRe.exec(body)) !== null) {
        const argsStr = pm[1] ?? "";
        const fieldName = pm[2]!;
        const isOptional = pm[3] === "?";
        const tsType = pm[4]!;

        // Extract description/enum from args
        const descMatch = /description:\s*['"`]([^'"`]+)['"`]/.exec(argsStr);
        const enumMatch = /enum:\s*\[([^\]]*)\]/.exec(argsStr);

        const prop: OpenAPISchema["properties"][string] = {
          type: mapTsTypeToOpenAPI(tsType),
        };
        if (descMatch) prop.description = descMatch[1]!;
        if (enumMatch) {
          prop.enum = enumMatch[1]!
            .split(",")
            .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ""))
            .filter(Boolean);
        }

        schema.properties[fieldName] = prop;
        if (!isOptional && !/@ApiPropertyOptional/.test(pm[0])) {
          schema.required!.push(fieldName);
        }
      }

      if (Object.keys(schema.properties).length > 0) {
        if (schema.required!.length === 0) delete schema.required;
        schemas[className] = schema;
      }
    }
  }

  // Step 2: Extract routes from controllers + project @ApiOperation/@ApiResponse into paths
  const controllerFiles = index.files.filter((f) => f.path.endsWith(".controller.ts"));
  for (const file of controllerFiles) {
    let source: string;
    try { source = await readFile(join(index.root, file.path), "utf-8"); } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    // Controller prefix
    const ctrlMatch = /@Controller\s*\(\s*(?:['"`]([^'"`]*)['"`]|\{[^}]*path:\s*['"`]([^'"`]*)['"`])/.exec(source);
    const ctrlPrefix = ctrlMatch?.[1] ?? ctrlMatch?.[2] ?? "";

    // @ApiTags at class level
    const tagsMatch = /@ApiTags\s*\(\s*((?:['"`][^'"`]+['"`]\s*,?\s*)+)\)/.exec(source);
    const tags = tagsMatch
      ? [...tagsMatch[1]!.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]!)
      : undefined;

    // Each HTTP method decorator
    const methods = ["Get", "Post", "Put", "Delete", "Patch", "All", "Head", "Options"];
    for (const method of methods) {
      const methodRe = new RegExp(
        `@${method}\\s*\\(\\s*(?:['"\`]([^'"\`]*)['"\`])?\\s*\\)`,
        "g",
      );
      let mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(source)) !== null) {
        const routePath = mm[1] ?? "";
        // Scan forward 500 chars for stacked @Api* decorators + handler name
        const lookFwd = source.slice(mm.index, mm.index + 800);

        const summaryMatch = /@ApiOperation\s*\(\s*\{[^}]*summary:\s*['"`]([^'"`]+)['"`]/.exec(lookFwd);
        const descMatch = /@ApiOperation\s*\(\s*\{[^}]*description:\s*['"`]([^'"`]+)['"`]/.exec(lookFwd);
        const bearerMatch = /@ApiBearerAuth\s*\(/.test(lookFwd);

        // Collect @ApiResponse decorators
        const responses: OpenAPIOperation["responses"] = {};
        const respRe = /@ApiResponse\s*\(\s*\{\s*status:\s*(\d+)(?:[\s\S]*?description:\s*['"`]([^'"`]+)['"`])?(?:[\s\S]*?type:\s*(\w+))?/g;
        let rm: RegExpExecArray | null;
        while ((rm = respRe.exec(lookFwd)) !== null) {
          const status = rm[1]!;
          const description = rm[2];
          const type = rm[3];
          responses[status] = {
            ...(description ? { description } : {}),
            ...(type ? { content: { "application/json": { schema: { $ref: `#/components/schemas/${type}` } } } } : {}),
          };
        }
        // Default 200 if no @ApiResponse
        if (Object.keys(responses).length === 0) {
          responses["200"] = { description: "Success" };
        }

        // @Param / @Query / @Body
        const parameters: OpenAPIOperation["parameters"] = [];
        const paramRe = /@(Param|Query)\s*\(\s*['"`](\w+)['"`]\s*\)\s*(\w+)\s*:\s*(\w+)/g;
        let pm2: RegExpExecArray | null;
        while ((pm2 = paramRe.exec(lookFwd)) !== null) {
          parameters.push({
            name: pm2[2]!,
            in: pm2[1] === "Param" ? "path" : "query",
            required: pm2[1] === "Param", // path params always required
            schema: { type: mapTsTypeToOpenAPI(pm2[4]!) },
          });
        }

        let requestBody: OpenAPIOperation["requestBody"] | undefined;
        const bodyMatch = /@Body\s*\(\s*\)\s*(\w+)\s*:\s*(\w+)/.exec(lookFwd);
        if (bodyMatch) {
          requestBody = {
            content: { "application/json": { schema: { $ref: `#/components/schemas/${bodyMatch[2]}` } } },
          };
        }

        const fullPath = `/${ctrlPrefix}/${routePath}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

        if (!paths[fullPath]) paths[fullPath] = {};

        const op: OpenAPIOperation = {
          path: fullPath,
          method: method.toUpperCase(),
          parameters,
          responses,
        };
        if (summaryMatch) op.summary = summaryMatch[1]!;
        if (descMatch) op.description = descMatch[1]!;
        if (tags) op.tags = tags;
        if (bearerMatch) op.security = [{ bearer: [] }];
        if (requestBody) op.requestBody = requestBody;

        paths[fullPath]![method.toLowerCase()] = op;
      }
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: options?.title ?? "NestJS API",
      version: options?.version ?? "1.0.0",
    },
    paths,
    components: { schemas },
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/** Map TypeScript type names to OpenAPI 3.1 primitive types */
function mapTsTypeToOpenAPI(tsType: string): string {
  const normalized = tsType.replace(/<.*>/, "").trim();
  switch (normalized) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "Date": return "string";
    case "Array":
    case "any[]": return "array";
    default: return "object";
  }
}
