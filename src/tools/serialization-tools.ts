/**
 * kotlinx.serialization contract extraction.
 *
 * extract_kotlin_serialization_contract — derive JSON schema from @Serializable
 * data classes by walking indexed symbol signatures + source for field names,
 * types, @SerialName remapping, nullable types, and default values.
 */
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SerializableField {
  name: string;
  serial_name: string;
  type: string;
  nullable: boolean;
  has_default: boolean;
}

export interface SerializableContract {
  class_name: string;
  file: string;
  start_line: number;
  fields: SerializableField[];
  is_polymorphic: boolean;
}

export interface SerializationContractResult {
  contracts: SerializableContract[];
  total_classes: number;
  total_fields: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Extract primary constructor parameters from a @Serializable data class source.
 * Returns structured field metadata for JSON schema generation.
 *
 * Handles:
 *   @SerialName("api_name") val localName: String
 *   val name: String? = null
 *   val items: List<Item> = emptyList()
 *   @Contextual val date: LocalDate
 */
function extractFields(sym: CodeSymbol): SerializableField[] {
  const source = sym.source ?? "";

  // Find the primary constructor opening paren, then scan for balanced close.
  // Can't use a simple regex because @SerialName("...") contains nested parens.
  const classMatch = /(?:data\s+)?class\s+\w+(?:\s*<[^>]+>)?\s*\(/.exec(source);
  if (!classMatch) return [];
  const openIdx = classMatch.index + classMatch[0].length;
  let depth = 1;
  let closeIdx = openIdx;
  for (let i = openIdx; i < source.length && depth > 0; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") depth--;
    closeIdx = i;
  }
  const paramBlock = source.slice(openIdx, closeIdx);
  const fields: SerializableField[] = [];

  // Split on top-level commas (respecting generics / nested parens).
  const params = splitTopLevelCommas(paramBlock);

  for (const raw of params) {
    const param = raw.trim();
    if (!param || !param.includes(":")) continue;

    // Check for @SerialName("name") annotation.
    const serialNameMatch = /@SerialName\s*\(\s*"([^"]+)"\s*\)/.exec(param);
    const serialName = serialNameMatch?.[1];

    // Strip annotations and val/var modifiers.
    const cleaned = param
      .replace(/@\w+(?:\([^)]*\))?\s*/g, "")
      .replace(/\b(?:private|public|internal|protected|override|val|var)\s+/g, "")
      .trim();

    const colonIdx = cleaned.indexOf(":");
    if (colonIdx === -1) continue;

    const fieldName = cleaned.slice(0, colonIdx).trim();
    let typeAndDefault = cleaned.slice(colonIdx + 1).trim();

    // Separate default value.
    let hasDefault = false;
    const eqIdx = findTopLevelEquals(typeAndDefault);
    if (eqIdx !== -1) {
      hasDefault = true;
      typeAndDefault = typeAndDefault.slice(0, eqIdx).trim();
    }

    // Handle trailing comma.
    const typeStr = typeAndDefault.replace(/,\s*$/, "").trim();

    const nullable = typeStr.endsWith("?");
    const baseType = nullable ? typeStr.slice(0, -1).trim() : typeStr;

    if (!fieldName) continue;

    fields.push({
      name: fieldName,
      serial_name: serialName ?? fieldName,
      type: baseType,
      nullable,
      has_default: hasDefault,
    });
  }

  return fields;
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function findTopLevelEquals(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    else if (ch === "=" && depth === 0) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export async function extractKotlinSerializationContract(
  repo: string,
  options?: { file_pattern?: string; class_name?: string },
): Promise<SerializationContractResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const contracts: SerializableContract[] = [];
  let totalFields = 0;

  for (const sym of index.symbols) {
    if (sym.kind !== "class") continue;
    if (!sym.decorators?.includes("Serializable")) {
      // Fallback: scan source
      if (!sym.source?.slice(0, 200).includes("@Serializable")) continue;
    }
    if (options?.file_pattern && !sym.file.includes(options.file_pattern)) continue;
    if (options?.class_name && sym.name !== options.class_name) continue;

    const fields = extractFields(sym);
    const isPolymorphic =
      sym.decorators?.includes("Polymorphic") ??
      /\b@Polymorphic\b/.test(sym.source?.slice(0, 200) ?? "");

    contracts.push({
      class_name: sym.name,
      file: sym.file,
      start_line: sym.start_line,
      fields,
      is_polymorphic: !!isPolymorphic,
    });
    totalFields += fields.length;
  }

  // Sort by name for stable output.
  contracts.sort((a, b) => a.class_name.localeCompare(b.class_name));

  return {
    contracts,
    total_classes: contracts.length,
    total_fields: totalFields,
  };
}
