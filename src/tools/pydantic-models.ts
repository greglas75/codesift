/**
 * get_pydantic_models — extract Pydantic BaseModel classes and their fields.
 *
 * FastAPI projects use Pydantic heavily for request/response schemas.
 * This tool extracts the class structure, fields with types, validators,
 * and cross-model references (e.g. `UserResponse` has `roles: list[Role]`).
 *
 * Complements get_model_graph (Django/SQLAlchemy) — Pydantic is the
 * FastAPI contract layer, not the persistence layer.
 */
import { getCodeIndex } from "./index-tools.js";

export interface PydanticField {
  name: string;
  type: string;
  optional: boolean;
  default?: string;
  /** Inline validators/constraints: Field(min_length=3), Field(gt=0), etc. */
  constraints: string[];
  /** Other Pydantic models this field references (for graph edges) */
  references: string[];
}

export interface PydanticModel {
  name: string;
  file: string;
  line: number;
  /** Parent class — BaseModel, GenericModel, own custom base, etc. */
  base: string;
  /** Model config overrides (strict mode, extra="forbid", etc.) */
  config: Record<string, string>;
  fields: PydanticField[];
  /** Validator method names defined inside the model */
  validators: string[];
  /** True if model extends another Pydantic model (inheritance) */
  is_derived: boolean;
}

export interface PydanticGraphEdge {
  from: string;
  to: string;
  field: string;
  kind: "reference" | "inheritance" | "list" | "optional";
}

export interface PydanticModelsResult {
  models: PydanticModel[];
  edges: PydanticGraphEdge[];
  total_models: number;
  total_fields: number;
}

const PYDANTIC_BASES = ["BaseModel", "GenericModel", "SQLModel", "pydantic.BaseModel"];

/** Parse `name: type = default` or `name: Type[X] = Field(...)` */
const FIELD_RE = /^\s*(\w+)\s*:\s*([^=\n]+?)(?:\s*=\s*(.+))?\s*(?:#.*)?$/;
/** Extract type names from an annotation like `list[User]`, `Optional[Post]`, `dict[str, Role]` */
const TYPE_REF_RE = /\b([A-Z]\w*)\b/g;
/** @validator / @field_validator / @model_validator decorators */
const VALIDATOR_DECORATOR_RE = /@(?:field_validator|model_validator|validator|root_validator)\b/;
/** Field(min_length=3, ge=0, ...) constraints extraction */
const FIELD_CALL_RE = /Field\s*\(([^)]*)\)/;
/** model_config = ConfigDict(strict=True, extra="forbid") */
const MODEL_CONFIG_RE = /model_config\s*=\s*ConfigDict\s*\(([^)]*)\)/;

/**
 * Extract Pydantic models from the indexed codebase.
 */
export async function getPydanticModels(
  repo: string,
  options?: {
    file_pattern?: string;
    output_format?: "json" | "mermaid";
  },
): Promise<PydanticModelsResult | { mermaid: string }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const filePattern = options?.file_pattern;

  // Pass 1a: collect all candidate Python classes (for transitive inheritance resolution)
  const candidates = index.symbols.filter((s) => {
    if (s.kind !== "class") return false;
    if (!s.file.endsWith(".py")) return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    return true;
  });
  const candidateByName = new Map<string, typeof candidates[0]>();
  for (const c of candidates) candidateByName.set(c.name, c);

  // Pass 1b: classify each candidate as Pydantic or not via transitive base walk
  const isPydantic = new Map<string, boolean>();
  function classify(name: string, visited = new Set<string>()): boolean {
    if (isPydantic.has(name)) return isPydantic.get(name)!;
    if (visited.has(name)) return false; // cycle guard
    visited.add(name);
    const sym = candidateByName.get(name);
    if (!sym) return false;
    const bases = sym.extends ?? [];
    const source = sym.source ?? "";
    // Direct match
    if (bases.some((b) => PYDANTIC_BASES.some((pb) => b.includes(pb)))) {
      isPydantic.set(name, true);
      return true;
    }
    // Source-level markers
    if (source.includes("model_config") || source.includes("= Field(") || source.includes("ConfigDict")) {
      isPydantic.set(name, true);
      return true;
    }
    // Transitive: check each base class
    for (const b of bases) {
      // Extract bare name (strip dots and generics)
      const bare = b.replace(/\[.*\]/, "").split(".").pop() ?? b;
      if (classify(bare, visited)) {
        isPydantic.set(name, true);
        return true;
      }
    }
    isPydantic.set(name, false);
    return false;
  }

  const modelSymbols = candidates.filter((c) => classify(c.name));

  // Build name → model for inheritance resolution
  const modelByName = new Map<string, typeof modelSymbols[0]>();
  for (const m of modelSymbols) modelByName.set(m.name, m);

  const models: PydanticModel[] = [];
  const edges: PydanticGraphEdge[] = [];

  for (const sym of modelSymbols) {
    const source = sym.source ?? "";
    const base = (sym.extends ?? [])[0] ?? "BaseModel";
    const isDerived = modelByName.has(base);

    // Extract model_config
    const config: Record<string, string> = {};
    const configMatch = source.match(MODEL_CONFIG_RE);
    if (configMatch) {
      const inner = configMatch[1]!;
      for (const part of inner.split(",")) {
        const [k, v] = part.split("=").map((s) => s.trim());
        if (k && v) config[k] = v.replace(/^['"]|['"]$/g, "");
      }
    }

    // Extract fields and validators by walking source lines
    const fields: PydanticField[] = [];
    const validators: string[] = [];
    const lines = source.split("\n");
    let inValidator = false;
    let classIndent = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();

      // Detect class opening line to calibrate indent
      if (classIndent === -1 && /^class\s+/.test(trimmed)) {
        // Next meaningful line after the docstring will set the indent
        continue;
      }

      // Validator decorator → next line is the validator function
      if (VALIDATOR_DECORATOR_RE.test(trimmed)) {
        inValidator = true;
        continue;
      }
      if (inValidator && /^\s*def\s+(\w+)/.test(line)) {
        const vm = line.match(/def\s+(\w+)/);
        if (vm) validators.push(vm[1]!);
        inValidator = false;
        continue;
      }

      // Skip nested methods
      if (/^\s*def\s+/.test(line)) continue;
      if (/^\s*@/.test(trimmed)) continue;
      if (!trimmed || trimmed.startsWith("#")) continue;
      // Skip docstrings
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) continue;
      // Skip model_config line
      if (trimmed.startsWith("model_config")) continue;

      // Try to parse as a field
      const m = trimmed.match(FIELD_RE);
      if (!m) continue;
      const fieldName = m[1]!;
      const rawType = m[2]!.trim();
      const rawDefault = m[3]?.trim();

      // Skip if name looks like a method or private internal
      if (fieldName === "model_config") continue;

      // Detect optional
      const optional = /\bOptional\b/.test(rawType) || rawType.endsWith("| None") || rawType.endsWith("|None");

      // Extract constraints from Field(...) default
      const constraints: string[] = [];
      if (rawDefault) {
        const fieldCall = rawDefault.match(FIELD_CALL_RE);
        if (fieldCall) {
          const inner = fieldCall[1]!;
          for (const part of inner.split(",")) {
            const trimmedPart = part.trim();
            if (trimmedPart && !trimmedPart.startsWith("default")) {
              constraints.push(trimmedPart);
            }
          }
        }
      }

      // Extract referenced types (capital-start identifiers)
      const refs = new Set<string>();
      TYPE_REF_RE.lastIndex = 0;
      let tm: RegExpExecArray | null;
      const SKIP_BUILTIN_TYPES = new Set([
        "Optional", "List", "Dict", "Set", "Tuple", "Union", "Any", "Field",
        "Type", "ClassVar", "Literal", "Annotated", "Final", "Callable",
      ]);
      while ((tm = TYPE_REF_RE.exec(rawType)) !== null) {
        const ref = tm[1]!;
        if (!SKIP_BUILTIN_TYPES.has(ref)) refs.add(ref);
      }

      const field: PydanticField = {
        name: fieldName,
        type: rawType,
        optional,
        constraints,
        references: [...refs],
      };
      if (rawDefault) field.default = rawDefault;
      fields.push(field);

      // Emit edges for references that resolve to other Pydantic models
      for (const ref of refs) {
        if (modelByName.has(ref) && ref !== sym.name) {
          const kind: PydanticGraphEdge["kind"] = /\blist\b/i.test(rawType)
            ? "list"
            : optional
              ? "optional"
              : "reference";
          edges.push({ from: sym.name, to: ref, field: fieldName, kind });
        }
      }
    }

    // Emit inheritance edge
    if (isDerived) {
      edges.push({ from: sym.name, to: base, field: "<inherits>", kind: "inheritance" });
    }

    models.push({
      name: sym.name,
      file: sym.file,
      line: sym.start_line,
      base,
      config,
      fields,
      validators,
      is_derived: isDerived,
    });
  }

  const totalFields = models.reduce((sum, m) => sum + m.fields.length, 0);

  const result: PydanticModelsResult = {
    models,
    edges,
    total_models: models.length,
    total_fields: totalFields,
  };

  if (options?.output_format === "mermaid") {
    return { mermaid: toMermaid(result) };
  }
  return result;
}

function toMermaid(result: PydanticModelsResult): string {
  const lines = ["classDiagram"];
  for (const m of result.models) {
    lines.push(`  class ${m.name} {`);
    for (const f of m.fields) {
      const marker = f.optional ? "?" : "";
      lines.push(`    ${f.name}${marker} ${f.type.slice(0, 30)}`);
    }
    lines.push("  }");
  }
  for (const e of result.edges) {
    if (e.kind === "inheritance") {
      lines.push(`  ${e.to} <|-- ${e.from}`);
    } else {
      const arrow = e.kind === "list" ? "--*" : e.kind === "optional" ? "--o" : "--";
      lines.push(`  ${e.from} ${arrow} ${e.to} : ${e.field}`);
    }
  }
  return lines.join("\n");
}
