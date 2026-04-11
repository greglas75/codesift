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
    const opRe = /@(Query|Mutation|Subscription|ResolveField)\s*\(([\s\S]*?)\)\s*\n?\s*(?:async\s+)?(\w+)\s*\(/g;
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
    const portMatch = /\b(\d+)\b/.exec(gwArgs);
    if (portMatch) entry.port = parseInt(portMatch[1]!, 10);

    // Namespace — from options object
    const nsMatch = /namespace:\s*['"`]([^'"`]+)['"`]/.exec(gwArgs);
    if (nsMatch) entry.namespace = nsMatch[1]!;

    // Find @SubscribeMessage handlers
    const subRe = /@SubscribeMessage\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\n?\s*(?:async\s+)?(\w+)\s*\(/g;
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
        regex: /@Cron\s*\(\s*['"`]([^'"`]+)['"`][^)]*\)\s*\n?\s*(?:async\s+)?(\w+)\s*\(/g,
        parseArg: (arg) => ({ expression: arg }),
      },
      {
        type: "@Interval",
        regex: /@Interval\s*\(\s*(\d+)\s*\)\s*\n?\s*(?:async\s+)?(\w+)\s*\(/g,
        parseArg: (arg) => ({ interval_ms: parseInt(arg, 10) }),
      },
      {
        type: "@Timeout",
        regex: /@Timeout\s*\(\s*(\d+)\s*\)\s*\n?\s*(?:async\s+)?(\w+)\s*\(/g,
        parseArg: (arg) => ({ interval_ms: parseInt(arg, 10) }),
      },
      {
        type: "@OnEvent",
        regex: /@OnEvent\s*\(\s*['"`]([^'"`]+)['"`][^)]*\)\s*\n?\s*(?:async\s+)?(\w+)\s*\(/g,
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
    const entityRe = /@Entity\s*\(\s*(?:['"`]([^'"`]+)['"`])?\s*\)\s*(?:export\s+)?class\s+(\w+)/g;
    let em: RegExpExecArray | null;
    while ((em = entityRe.exec(source)) !== null) {
      if (entities.length >= maxEntities) { truncated = true; break; }
      const tableName = em[1];
      const entityName = em[2]!;
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

    const patternRe = /@(MessagePattern|EventPattern)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\n?\s*(?:async\s+)?(\w+)\s*\(/g;
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
