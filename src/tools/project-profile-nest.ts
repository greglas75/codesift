import type {
  MiddlewareChainEntry,
  NestConventions,
  NestModuleEntry,
  NestProviderEntry,
} from "./project-profile-types.js";

function countBracketBalance(text: string): number {
  let depth = 0;
  for (const ch of text) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
  }
  return depth;
}

export function extractNestConventions(
  source: string,
  filePath: string,
): NestConventions {
  const lines = source.split("\n");

  // Build import map
  const importMap = new Map<string, string>();
  for (const line of lines) {
    const defaultImport = line.match(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (defaultImport) {
      const names = defaultImport[1]!.split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim());
      for (const name of names) {
        importMap.set(name, defaultImport[2]!);
      }
    }
  }

  const modules: NestModuleEntry[] = [];
  const global_guards: NestProviderEntry[] = [];
  const global_filters: NestProviderEntry[] = [];
  const global_pipes: NestProviderEntry[] = [];
  const global_interceptors: NestProviderEntry[] = [];
  const controllers: string[] = [];
  let throttler: NestConventions["throttler"] = null;

  let inImports = false;
  let importsBracketDepth = 0;
  let inProviders = false;
  let providersBracketDepth = 0;
  let inControllers = false;
  let controllersBracketDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Track @Module sections via bracket depth — handles both multi-line arrays
    // (imports: [\n  A,\n  B,\n]) and single-line arrays (imports: [A, B]).
    // Critical: mark inImports BEFORE scanning the current line so the scan
    // block runs on single-line `imports: [...]` arrays.
    let closeInImportsAfterLine = false;
    if (/imports:\s*\[/.test(line)) {
      inImports = true;
      importsBracketDepth += countBracketBalance(line.slice(line.indexOf("[")));
      if (importsBracketDepth <= 0) { closeInImportsAfterLine = true; importsBracketDepth = 0; }
    } else if (inImports) {
      importsBracketDepth += countBracketBalance(line);
      if (importsBracketDepth <= 0) { closeInImportsAfterLine = true; importsBracketDepth = 0; }
    }

    // R-1 fix: use bracket-depth tracking for providers/controllers too
    // (same approach as imports) so single-line arrays close correctly.
    let closeProvidersAfterLine = false;
    if (/providers:\s*\[/.test(line)) {
      inProviders = true;
      providersBracketDepth += countBracketBalance(line.slice(line.indexOf("[", line.indexOf("providers"))));
      if (providersBracketDepth <= 0) { closeProvidersAfterLine = true; providersBracketDepth = 0; }
    } else if (inProviders) {
      providersBracketDepth += countBracketBalance(line);
      if (providersBracketDepth <= 0) { closeProvidersAfterLine = true; providersBracketDepth = 0; }
    }

    let closeControllersAfterLine = false;
    if (/controllers:\s*\[/.test(line)) {
      inControllers = true;
      controllersBracketDepth += countBracketBalance(line.slice(line.indexOf("[", line.indexOf("controllers"))));
      if (controllersBracketDepth <= 0) { closeControllersAfterLine = true; controllersBracketDepth = 0; }
    } else if (inControllers) {
      controllersBracketDepth += countBracketBalance(line);
      if (controllersBracketDepth <= 0) { closeControllersAfterLine = true; controllersBracketDepth = 0; }
    }

    // Extract module imports — scan for all module names on the line (not just
    // the first indented one). Handles single-line `imports: [A, B.forFeature([...]), C]`
    // where multiple modules share one line.
    if (inImports) {
      const moduleRe = /(\w+Module)(?:\.for(Root|Feature)(?:Async)?\s*\()?/g;
      let moduleMatch: RegExpExecArray | null;
      const matchedThisLine = new Set<string>();
      while ((moduleMatch = moduleRe.exec(line)) !== null) {
        // Avoid duplicates within the same line
        const key = `${moduleMatch[1]}:${moduleMatch.index}`;
        if (matchedThisLine.has(key)) continue;
        matchedThisLine.add(key);
        const name = moduleMatch[1]!;
        const dynamicKind = moduleMatch[2]; // "Root" | "Feature" | undefined
        const isGlobal = /isGlobal:\s*true/.test(line) || /ConfigModule|SentryModule/.test(name);

        const entry: NestModuleEntry = {
          name,
          file: filePath,
          line: lineNum,
          imported_from: importMap.get(name) ?? null,
          is_global: isGlobal,
        };

        // G2: forFeature([...]) — extract entity class names (scan ahead up to 15 lines)
        if (dynamicKind === "Feature") {
          const entities: string[] = [];
          let bracketDepth = 0;
          let started = false;
          for (let j = i; j < Math.min(i + 15, lines.length); j++) {
            for (const ch of lines[j]!) {
              if (ch === "[") { bracketDepth++; started = true; }
              else if (ch === "]") { bracketDepth--; if (started && bracketDepth === 0) break; }
            }
            // Capture entity names after the opening [
            const featureMatch = lines[j]!.match(/forFeature\s*\(\s*\[([^\]]*)\]?/);
            if (featureMatch) {
              const inner = featureMatch[1]!;
              for (const m of inner.matchAll(/\b([A-Z]\w*)\b/g)) entities.push(m[1]!);
              // Continue to next lines if the array spans multiple
              for (let k = j + 1; k < Math.min(j + 10, lines.length) && !/\]/.test(lines[k - 1]!); k++) {
                for (const m of lines[k]!.matchAll(/\b([A-Z]\w*)\b/g)) entities.push(m[1]!);
              }
              break;
            }
            // Multi-line case: forFeature([ on one line, entities on next
            if (/forFeature\s*\(\s*\[\s*$/.test(lines[j]!)) {
              for (let k = j + 1; k < Math.min(j + 10, lines.length); k++) {
                if (/^\s*\]/.test(lines[k]!)) break;
                for (const m of lines[k]!.matchAll(/\b([A-Z]\w*)\b/g)) entities.push(m[1]!);
              }
              break;
            }
          }
          if (entities.length > 0) entry.entities = entities;
        }

        // G2: forRoot({...}) — extract top-level config keys
        if (dynamicKind === "Root") {
          const keys: string[] = [];
          let braceDepth = 0;
          for (let j = i; j < Math.min(i + 15, lines.length); j++) {
            for (const ch of lines[j]!) {
              if (ch === "{") braceDepth++;
              else if (ch === "}") braceDepth--;
            }
            // Only capture keys at the top-level of the forRoot config object
            if (braceDepth >= 1) {
              // Match indented key: value pattern at top-level (heuristic: 1-level indent)
              const keyMatch = lines[j]!.match(/^\s{6,10}(\w+):\s*/);
              if (keyMatch && !keys.includes(keyMatch[1]!)) keys.push(keyMatch[1]!);
            }
            if (braceDepth === 0 && j > i) break;
          }
          if (keys.length > 0) entry.dynamic_config_keys = keys;
        }

        modules.push(entry);
      }

      // Extract ThrottlerModule config
      if (/ThrottlerModule/.test(line)) {
        // Scan ahead for ttl and limit
        for (let j = i; j < Math.min(i + 15, lines.length); j++) {
          const ttlMatch = lines[j]!.match(/ttl:\s*(\d+)/);
          const limitMatch = lines[j]!.match(/limit:\s*(?:.*?:\s*)?(\d+)/);
          if (ttlMatch && !throttler) {
            throttler = { ttl: parseInt(ttlMatch[1]!), limit: 60 };
          }
          if (limitMatch && throttler) {
            // Take the production value (non-development)
            const allLimits = lines[j]!.match(/(\d+)/g);
            if (allLimits && allLimits.length > 0) {
              throttler.limit = parseInt(allLimits[allLimits.length - 1]!);
            }
          }
        }
      }
    }

    // Extract controllers
    if (inControllers) {
      const ctrlMatch = line.match(/(\w+Controller)\b/);
      if (ctrlMatch) controllers.push(ctrlMatch[1]!);
    }

    // Extract global providers (APP_GUARD, APP_FILTER, APP_PIPE)
    if (inProviders) {
      if (/provide:\s*APP_GUARD/.test(line)) {
        // Scan for useClass on next lines
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          const useClassMatch = lines[j]!.match(/useClass:\s*(\w+)/);
          if (useClassMatch) {
            global_guards.push({
              name: useClassMatch[1]!,
              token: "APP_GUARD",
              file: filePath,
              line: j + 1,
              imported_from: importMap.get(useClassMatch[1]!) ?? null,
            });
            break;
          }
        }
      }
      if (/provide:\s*APP_FILTER/.test(line)) {
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          const useClassMatch = lines[j]!.match(/useClass:\s*(\w+)/);
          if (useClassMatch) {
            global_filters.push({
              name: useClassMatch[1]!,
              token: "APP_FILTER",
              file: filePath,
              line: j + 1,
              imported_from: importMap.get(useClassMatch[1]!) ?? null,
            });
            break;
          }
        }
      }
      if (/provide:\s*APP_PIPE/.test(line)) {
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          const useClassMatch = lines[j]!.match(/useClass:\s*(\w+)/);
          if (useClassMatch) {
            global_pipes.push({
              name: useClassMatch[1]!,
              token: "APP_PIPE",
              file: filePath,
              line: j + 1,
              imported_from: importMap.get(useClassMatch[1]!) ?? null,
            });
            break;
          }
        }
      }
      if (/provide:\s*APP_INTERCEPTOR/.test(line)) {
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          const useClassMatch = lines[j]!.match(/useClass:\s*(\w+)/);
          if (useClassMatch) {
            global_interceptors.push({
              name: useClassMatch[1]!,
              token: "APP_INTERCEPTOR",
              file: filePath,
              line: j + 1,
              imported_from: importMap.get(useClassMatch[1]!) ?? null,
            });
            break;
          }
        }
      }
    }

    // Close inImports at end of line iteration if brackets balanced
    if (closeInImportsAfterLine) inImports = false;
    if (closeProvidersAfterLine) inProviders = false;
    if (closeControllersAfterLine) inControllers = false;
  }

  // G1: parse middleware.configure(consumer) chains
  const middleware_chains = parseMiddlewareChains(source, filePath);

  return { modules, global_guards, global_filters, global_pipes, global_interceptors, controllers, throttler, middleware_chains };
}

/**
 * G1: Parse `configure(consumer: MiddlewareConsumer) { ... }` blocks.
 * Extracts consumer.apply(Middleware).forRoutes(...) chains.
 */
export function parseMiddlewareChains(source: string, filePath: string): MiddlewareChainEntry[] {
  const results: MiddlewareChainEntry[] = [];

  // Find configure( method — can be `configure(consumer` or `configure(consumer: MiddlewareConsumer)`
  const configureStart = source.search(/\bconfigure\s*\(\s*\w+\s*(?::\s*\w+)?\s*\)\s*\{/);
  if (configureStart === -1) return results;

  // Extract body of configure method via brace counting
  const bodyStart = source.indexOf("{", configureStart);
  if (bodyStart === -1) return results;
  let depth = 1;
  let i = bodyStart + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  const body = source.slice(bodyStart + 1, i - 1);

  // Match: consumer.apply(Middleware).forRoutes(<args>) — may chain multiple middlewares
  // Use a tolerant pattern that captures the apply(...) arg and forRoutes(...) arg separately.
  const applyRe = /\.apply\s*\(\s*([\w,\s]+)\s*\)\s*\.forRoutes\s*\(([\s\S]*?)\)\s*[;}]/g;
  let m: RegExpExecArray | null;
  while ((m = applyRe.exec(body)) !== null) {
    const middlewareNames = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
    const routesArg = m[2]!;

    const routes: Array<{ path: string; method?: string }> = [];

    // Parse routesArg — supports:
    //   '*'
    //   'users/*'
    //   { path: 'users', method: RequestMethod.GET }
    //   ControllerClass
    const stringPathRe = /['"`]([^'"`]+)['"`]/g;
    let sm: RegExpExecArray | null;
    while ((sm = stringPathRe.exec(routesArg)) !== null) {
      // Check if this string is part of a { path: '...', method: ... } object literal
      const before = routesArg.slice(Math.max(0, sm.index - 30), sm.index);
      if (/path:\s*$/.test(before)) {
        // Object form — capture path AND method
        const objRe = /path:\s*['"`]([^'"`]+)['"`]\s*,\s*method:\s*(?:RequestMethod\.)?(\w+)/;
        const afterContext = routesArg.slice(Math.max(0, sm.index - 20), sm.index + 200);
        const objMatch = objRe.exec(afterContext);
        if (objMatch) {
          routes.push({ path: objMatch[1]!, method: objMatch[2]! });
          continue;
        }
      }
      routes.push({ path: sm[1]! });
    }

    // Also capture bare ControllerClass (PascalCase identifier) if present
    for (const name of middlewareNames) {
      // R-3 fix: guard indexOf returning -1 (would produce wrong line via slice(0,-1))
      const namePos = source.indexOf(name, configureStart);
      const line = namePos >= 0 ? source.slice(0, namePos).split("\n").length : 0;
      results.push({ middleware: name, routes, file: filePath, line });
    }
  }

  return results;
}
