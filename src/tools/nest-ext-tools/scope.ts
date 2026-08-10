import {
  findDecoratedClass,
  findDecoratorCalls,
  findNestClassRanges,
  firstNestDecoratorArgument,
  readNestSource,
  requireNestCodeIndex,
  splitTopLevelNestArguments,
} from "./shared.js";
import type { NestToolError } from "../nest-tools.js";

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
  graph_incomplete?: boolean;
}

export async function nestScopeAudit(
  repo: string,
  options?: { max_providers?: number },
): Promise<NestScopeAuditResult> {
  const index = await requireNestCodeIndex(repo);

  const maxProviders = options?.max_providers ?? 200;
  const errors: NestToolError[] = [];
  let truncated = false;

  // First: build a full DI edge map (source → target) across all injectable providers.
  // We need the INVERSE graph: for each request-scoped provider, find all transitive
  // consumers that become implicitly request-scoped.
  interface ProviderInfo {
    key: string;
    name: string;
    file: string;
    scope: "REQUEST" | "TRANSIENT" | "DEFAULT";
  }
  const providers = new Map<string, ProviderInfo>();
  const rawInjectEdges: Array<{ from: string; target: string }> = []; // consumer → injected token

  const candidateFiles = index.files.filter((f) => f.path.endsWith(".ts") || f.path.endsWith(".js"));
  for (const file of candidateFiles) {
    if (providers.size >= maxProviders) { truncated = true; break; }
    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;

    if (!/@Injectable/.test(source)) continue;

    const classRanges = findNestClassRanges(source);
    for (const call of findDecoratorCalls(source, "Injectable")) {
      if (providers.size >= maxProviders) {
        truncated = true;
        break;
      }
      const owner = findDecoratedClass(classRanges, call);
      if (!owner) continue;
      const args = call.args;
      const name = owner.name;
      const key = `${file.path}:${name}`;
      const scopeMatch = args.match(/scope:\s*(?:\w+\.)?(REQUEST|TRANSIENT|DEFAULT)\b/);
      const scope = (scopeMatch?.[1] ?? "DEFAULT") as ProviderInfo["scope"];
      providers.set(key, { key, name, file: file.path, scope });

      const classSource = source.slice(owner.bodyStart + 1, owner.end - 1);
      const ctorMatch = /constructor\s*\(([\s\S]*?)\)\s*\{/.exec(classSource);
      if (!ctorMatch) continue;
      const ctorBody = ctorMatch[1]!;
      for (const parameter of splitTopLevelNestArguments(ctorBody)) {
        const injectCall = findDecoratorCalls(parameter, "Inject")[0];
        const explicitToken = injectCall
          ? normalizeInjectionToken(firstNestDecoratorArgument(injectCall.args))
          : undefined;
        const typeMatch = /:\s*(\w+)(?:<\s*(\w+)\s*>)?/.exec(parameter);
        const outer = typeMatch?.[1];
        const inner = typeMatch?.[2];
        const inferred = outer && /^(Repository|Model|Collection|Array|Set|Map|List|Observable|Promise)$/.test(outer) && inner
          ? inner
          : outer;
        const target = explicitToken ?? inferred;
        if (!target || /^(string|number|boolean|unknown|any|object|symbol|bigint)$/.test(target)) continue;
        rawInjectEdges.push({ from: key, target });
      }
    }
  }

  const keysByName = new Map<string, string[]>();
  for (const info of providers.values()) {
    const keys = keysByName.get(info.name) ?? [];
    keys.push(info.key);
    keysByName.set(info.name, keys);
  }

  // Build reverse index: for each target, who injects it?
  const injectedBy = new Map<string, Set<string>>();
  for (const edge of rawInjectEdges) {
    const targets = keysByName.get(edge.target);
    if (!targets || targets.length !== 1) continue;
    const target = targets[0]!;
    if (!injectedBy.has(target)) injectedBy.set(target, new Set());
    injectedBy.get(target)!.add(edge.from);
  }

  // For each REQUEST/TRANSIENT provider, walk the reverse graph (BFS) to find all consumers
  const displayName = (key: string): string => {
    const info = providers.get(key);
    if (!info) return key;
    return (keysByName.get(info.name)?.length ?? 0) > 1
      ? `${info.name} (${info.file})`
      : info.name;
  };
  const walkConsumers = (startKey: string): string[] => {
    const visited = new Set<string>([startKey]);
    const queue = [startKey];
    const consumers: string[] = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const parents = injectedBy.get(cur);
      if (!parents) continue;
      for (const parent of parents) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        consumers.push(displayName(parent));
        queue.push(parent);
      }
    }
    return consumers;
  };

  const request_scoped: NestScopeIssue[] = [];
  const transient_scoped: NestScopeIssue[] = [];
  for (const [key, info] of providers) {
    if (info.scope === "REQUEST") {
      request_scoped.push({
        provider: displayName(key),
        scope: "REQUEST",
        file: info.file,
        escalated_consumers: walkConsumers(key),
      });
    } else if (info.scope === "TRANSIENT") {
      transient_scoped.push({
        provider: displayName(key),
        scope: "TRANSIENT",
        file: info.file,
        escalated_consumers: [],
      });
    }
  }

  return {
    request_scoped,
    transient_scoped,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
    ...(truncated ? { graph_incomplete: true } : {}),
  };
}

function normalizeInjectionToken(value: string): string | undefined {
  const trimmed = value.trim();
  const stringToken = /^['"`]([^'"`]+)['"`]$/.exec(trimmed)?.[1];
  if (stringToken) return stringToken;
  const forwardRef = /^forwardRef\s*\(\s*\(\s*\)\s*=>\s*(\w+)\s*\)$/.exec(trimmed)?.[1];
  if (forwardRef) return forwardRef;
  return /^(\w+)$/.exec(trimmed)?.[1];
}
