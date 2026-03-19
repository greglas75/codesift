import type { CodeSymbol } from "../../types.js";
import { makeSymbolId, tokenizeIdentifier } from "../symbol-extractor.js";

/**
 * Extract symbols from Astro files.
 *
 * Astro files have TypeScript frontmatter between --- fences,
 * followed by HTML template. We extract:
 * - interface Props (component props)
 * - const declarations (exported config, data)
 * - function declarations
 * - import statements (as metadata, not symbols)
 *
 * The template portion is not parsed for symbols since it's HTML.
 */
export function extractAstroSymbols(
  source: string,
  filePath: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  // Extract frontmatter between --- fences
  const fmMatch = source.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    // No frontmatter — treat as pure template, extract component name from filename
    const name = filePath.split("/").pop()?.replace(".astro", "") ?? filePath;
    symbols.push({
      id: makeSymbolId(repo, filePath, name, 1),
      repo,
      name,
      kind: "function", // Astro components are like functions
      file: filePath,
      start_line: 1,
      end_line: source.split("\n").length,
      source: source.slice(0, 500),
    });
    return symbols;
  }

  const frontmatter = fmMatch[1]!;
  const fmStartLine = 2; // Line after first ---

  // Extract interface Props
  const propsMatch = frontmatter.match(/interface\s+Props\s*\{[\s\S]*?\}/);
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
    });
  }

  // Extract const declarations
  const constRe = /(?:export\s+)?const\s+(\w+)\s*[=:]/g;
  let match: RegExpExecArray | null;
  while ((match = constRe.exec(frontmatter)) !== null) {
    const name = match[1]!;
    const line = frontmatter.slice(0, match.index).split("\n").length;
    // Get the full declaration (up to next const/function/interface or end)
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
    });
  }

  // Extract function declarations
  const funcRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
  while ((match = funcRe.exec(frontmatter)) !== null) {
    const name = match[1]!;
    const line = frontmatter.slice(0, match.index).split("\n").length;
    symbols.push({
      id: makeSymbolId(repo, filePath, name, fmStartLine + line - 1),
      repo,
      name,
      kind: "function",
      file: filePath,
      start_line: fmStartLine + line - 1,
      end_line: fmStartLine + line - 1,
      source: match[0],
    });
  }

  // Add the component itself as a symbol
  const componentName = filePath.split("/").pop()?.replace(".astro", "") ?? filePath;
  const totalLines = source.split("\n").length;
  symbols.push({
    id: makeSymbolId(repo, filePath, componentName, 1),
    repo,
    name: componentName,
    kind: "function",
    file: filePath,
    start_line: 1,
    end_line: totalLines,
    source: frontmatter.slice(0, 500),
    tokens: tokenizeIdentifier(componentName),
  });

  return symbols;
}
