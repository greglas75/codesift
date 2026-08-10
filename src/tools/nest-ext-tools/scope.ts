import {
  findDecoratedClass,
  findDecoratorCalls,
  findNestClassRanges,
  readNestSource,
  requireNestCodeIndex,
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
    name: string;
    file: string;
    scope: "REQUEST" | "TRANSIENT" | "DEFAULT";
  }
  const providers = new Map<string, ProviderInfo>();
  const injectEdges: Array<{ from: string; to: string }> = []; // consumer → injected

  const candidateFiles = index.files.filter((f) => f.path.endsWith(".ts") || f.path.endsWith(".js"));
  for (const file of candidateFiles) {
    if (providers.size >= maxProviders) { truncated = true; break; }
    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;

    if (!/@Injectable/.test(source)) continue;

    const classRanges = findNestClassRanges(source);
    for (const call of findDecoratorCalls(source, "Injectable")) {
      const owner = findDecoratedClass(classRanges, call);
      if (!owner) continue;
      const args = call.args;
      const name = owner.name;
      const scopeMatch = args.match(/scope:\s*Scope\.(\w+)/);
      const scope = (scopeMatch?.[1] ?? "DEFAULT") as ProviderInfo["scope"];
      providers.set(name, { name, file: file.path, scope });

      const classSource = source.slice(owner.bodyStart + 1, owner.end - 1);
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
    const visited = new Set<string>([startName]);
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
