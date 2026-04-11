import type { CodeSymbol } from "../../types.js";
import { makeSymbolId, tokenizeIdentifier } from "../symbol-extractor.js";
import { parseAstroTemplate } from "../astro-template.js";

/**
 * Extract symbols from Astro files.
 *
 * Astro files have TypeScript frontmatter between --- fences,
 * followed by HTML template. We extract:
 * - interface Props / type Props (component props)
 * - const declarations (exported config, data)
 * - function declarations (including SSR exports like GET, getStaticPaths)
 * - the component itself (kind: "component")
 * - template islands/component usages via parseAstroTemplate
 */
export function extractAstroSymbols(
  source: string,
  filePath: string,
  repo: string,
): CodeSymbol[] {
  // PP-1: Normalize BOM and CRLF at entry
  source = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

  const symbols: CodeSymbol[] = [];
  const componentName = filePath.split("/").pop()?.replace(".astro", "") ?? filePath;
  const totalLines = source.split("\n").length;

  // Extract frontmatter between --- fences (tolerant of trailing spaces)
  const fmMatch = source.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);

  if (!fmMatch) {
    // PP-6: No frontmatter — template-only file. Don't store raw HTML as source.
    symbols.push({
      id: makeSymbolId(repo, filePath, componentName, 1),
      repo,
      name: componentName,
      kind: "component",
      file: filePath,
      start_line: 1,
      end_line: totalLines,
      source: `--- (template-only component: ${componentName}) ---`,
      tokens: tokenizeIdentifier(componentName),
    });
    // Parse template for islands/usages
    const tplResult = parseAstroTemplate(source);
    if (tplResult.component_usages.length > 0) {
      const comp = symbols[symbols.length - 1]!;
      comp.meta = { template: tplResult };
    }
    return symbols;
  }

  const frontmatter = fmMatch[1]!;
  const fmStartLine = 2; // Line after first ---

  // Build import map for template parser
  const frontmatterImports = new Map<string, string>();
  const importRe = /import\s+(\w+)\s+from\s+["']([^"']+)["']/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(frontmatter)) !== null) {
    frontmatterImports.set(im[1]!, im[2]!);
  }
  // Also handle: import { X } from '...'  and  import X, { Y } from '...'
  const namedImportRe = /import\s+(?:\w+\s*,\s*)?\{\s*([^}]+)\}\s*from\s+["']([^"']+)["']/g;
  while ((im = namedImportRe.exec(frontmatter)) !== null) {
    const names = im[1]!.split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim());
    for (const n of names) if (n) frontmatterImports.set(n, im[2]!);
  }

  // EC-16 + EC-17: Extract interface Props (with optional extends) and type Props
  const propsIfaceRe = /interface\s+Props\s+(?:extends\s+[\w,\s]+\s*)?\{[\s\S]*?\}/;
  const propsMatch = frontmatter.match(propsIfaceRe);
  if (propsMatch) {
    const propsLine = frontmatter.slice(0, frontmatter.indexOf(propsMatch[0])).split("\n").length;
    symbols.push({
      id: makeSymbolId(repo, filePath, "Props", fmStartLine + propsLine - 1),
      repo,
      name: "Props",
      kind: "interface",
      file: filePath,
      start_line: fmStartLine + propsLine - 1,
      end_line: fmStartLine + propsLine - 1 + propsMatch[0].split("\n").length - 1,
      source: propsMatch[0],
      tokens: tokenizeIdentifier("Props"),
    });
  } else {
    // EC-17: type Props = { ... }
    const typePropsRe = /type\s+Props\s*=\s*\{[\s\S]*?\}/;
    const typeMatch = frontmatter.match(typePropsRe);
    if (typeMatch) {
      const propsLine = frontmatter.slice(0, frontmatter.indexOf(typeMatch[0])).split("\n").length;
      symbols.push({
        id: makeSymbolId(repo, filePath, "Props", fmStartLine + propsLine - 1),
        repo,
        name: "Props",
        kind: "type",
        file: filePath,
        start_line: fmStartLine + propsLine - 1,
        end_line: fmStartLine + propsLine - 1 + typeMatch[0].split("\n").length - 1,
        source: typeMatch[0],
        tokens: tokenizeIdentifier("Props"),
      });
    }
  }

  // Extract const declarations (PP-5: add tokens)
  const constRe = /(?:export\s+)?const\s+(\w+)\s*[=:]/g;
  let match: RegExpExecArray | null;
  while ((match = constRe.exec(frontmatter)) !== null) {
    const name = match[1]!;
    const line = frontmatter.slice(0, match.index).split("\n").length;
    const restOfFm = frontmatter.slice(match.index);
    const endMatch = restOfFm.match(/\n(?:export\s+)?(?:const|let|function|interface|type)\s/);
    const declEnd = endMatch ? match.index + endMatch.index! : match.index + restOfFm.length;
    const declSource = frontmatter.slice(match.index, declEnd).trim();

    symbols.push({
      id: makeSymbolId(repo, filePath, name, fmStartLine + line - 1),
      repo,
      name,
      kind: "variable",
      file: filePath,
      start_line: fmStartLine + line - 1,
      end_line: fmStartLine + line - 1 + declSource.split("\n").length - 1,
      source: declSource.slice(0, 1000),
      tokens: tokenizeIdentifier(name),
    });
  }

  // Extract function declarations (PP-3: track braces for end_line; PP-5: add tokens)
  const funcRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
  while ((match = funcRe.exec(frontmatter)) !== null) {
    const name = match[1]!;
    const startIdx = match.index;
    const line = frontmatter.slice(0, startIdx).split("\n").length;

    // PP-3: find the full function body by tracking balanced braces
    let braceStart = frontmatter.indexOf("{", startIdx + match[0].length);
    let funcSource = match[0];
    let funcEndLine = fmStartLine + line - 1;

    if (braceStart >= 0) {
      let depth = 0;
      let i = braceStart;
      for (; i < frontmatter.length; i++) {
        if (frontmatter[i] === "{") depth++;
        else if (frontmatter[i] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      funcSource = frontmatter.slice(startIdx, i + 1).trim();
      funcEndLine = fmStartLine + frontmatter.slice(0, i + 1).split("\n").length - 1;
    }

    symbols.push({
      id: makeSymbolId(repo, filePath, name, fmStartLine + line - 1),
      repo,
      name,
      kind: "function",
      file: filePath,
      start_line: fmStartLine + line - 1,
      end_line: funcEndLine,
      source: funcSource.slice(0, 1000),
      tokens: tokenizeIdentifier(name),
    });
  }

  // PP-4: Add the component itself as kind: "component"
  // EC-2: Only emit if there's actual template content (not frontmatter-only)
  const templateContent = source.slice(fmMatch[0].length).trim();
  const hasTemplate = templateContent.length > 0;

  symbols.push({
    id: makeSymbolId(repo, filePath, componentName, 1),
    repo,
    name: componentName,
    kind: "component",
    file: filePath,
    start_line: 1,
    end_line: totalLines,
    source: frontmatter.slice(0, 500),
    tokens: tokenizeIdentifier(componentName),
  });

  // Template integration: parse template for islands/component usages
  if (hasTemplate) {
    const tplResult = parseAstroTemplate(source, frontmatterImports);
    if (tplResult.islands.length > 0 || tplResult.component_usages.length > 0 || tplResult.slots.length > 0) {
      const comp = symbols[symbols.length - 1]!;
      comp.meta = { template: tplResult };
    }
  }

  return symbols;
}
