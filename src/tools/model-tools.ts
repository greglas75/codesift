/**
 * ORM model relationship graph extraction.
 * Supports Django (ForeignKey, ManyToManyField, OneToOneField) and
 * SQLAlchemy (relationship, ForeignKey Column).
 */
import { getCodeIndex } from "./index-tools.js";

export interface ModelNode {
  name: string;
  file: string;
  fields: Array<{ name: string; type: string }>;
}

export interface ModelEdge {
  from: string;     // source model name
  to: string;       // target model name
  field: string;    // field name on the source model
  relationship: "fk" | "o2o" | "m2m" | "relationship";
}

export interface ModelGraph {
  models: ModelNode[];
  edges: ModelEdge[];
  framework: "django" | "sqlalchemy" | "unknown";
}

// Django relationship field patterns
const DJANGO_FK_RE = /(\w+)\s*=\s*(?:models\.)?ForeignKey\s*\(\s*['"]?(\w+)['"]?/g;
const DJANGO_O2O_RE = /(\w+)\s*=\s*(?:models\.)?OneToOneField\s*\(\s*['"]?(\w+)['"]?/g;
const DJANGO_M2M_RE = /(\w+)\s*=\s*(?:models\.)?ManyToManyField\s*\(\s*['"]?(\w+)['"]?/g;

// SQLAlchemy relationship patterns
const SQLA_REL_RE = /(\w+)\s*=\s*relationship\s*\(\s*['"](\w+)['"]/g;
const SQLA_FK_COL_RE = /(\w+)\s*=\s*Column\s*\([^)]*ForeignKey\s*\(\s*['"](\w+)\.(\w+)['"]/g;

// Django field type extraction (non-relationship fields)
const DJANGO_FIELD_RE = /(\w+)\s*=\s*(?:models\.)?(\w+Field)\s*\(/g;

// SQLAlchemy Column type extraction
const SQLA_COL_RE = /(\w+)\s*=\s*Column\s*\(\s*(\w+)/g;

/**
 * Extract ORM model relationships from a repository.
 * Scans model classes for Django and SQLAlchemy relationship declarations.
 */
export async function getModelGraph(
  repo: string,
  options?: {
    file_pattern?: string;
    output_format?: "json" | "mermaid";
  },
): Promise<ModelGraph | { mermaid: string }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const filePattern = options?.file_pattern;

  // Find model classes — Python classes that look like ORM models
  const modelSymbols = index.symbols.filter((s) => {
    if (s.kind !== "class") return false;
    if (!s.file.endsWith(".py")) return false;
    if (filePattern && !s.file.includes(filePattern)) return false;
    // Check extends for ORM base classes
    const bases = s.extends ?? [];
    const modelBases = [
      "Model", "models.Model", "Base", "DeclarativeBase",
      "db.Model", "SQLModel", "BaseModel",
    ];
    return bases.some((b) => modelBases.some((mb) => b.includes(mb)))
      || (s.source ?? "").includes("models.Model")
      || (s.source ?? "").includes("= Column(")
      || (s.source ?? "").includes("= relationship(");
  });

  const models: ModelNode[] = [];
  const edges: ModelEdge[] = [];
  let framework: ModelGraph["framework"] = "unknown";

  for (const sym of modelSymbols) {
    const source = sym.source ?? "";
    const fields: ModelNode["fields"] = [];

    // Detect framework
    if (source.includes("models.Model") || (source.includes("ForeignKey") && source.includes("on_delete"))) {
      framework = "django";
    } else if (source.includes("Column(") || source.includes("relationship(")) {
      framework = "sqlalchemy";
    }

    // Extract Django relationships
    for (const [re, relType] of [
      [DJANGO_FK_RE, "fk"],
      [DJANGO_O2O_RE, "o2o"],
      [DJANGO_M2M_RE, "m2m"],
    ] as const) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        const fieldName = match[1]!;
        const targetModel = match[2]!;
        edges.push({
          from: sym.name,
          to: targetModel,
          field: fieldName,
          relationship: relType,
        });
        fields.push({ name: fieldName, type: `${relType}(${targetModel})` });
      }
    }

    // Extract SQLAlchemy relationships
    SQLA_REL_RE.lastIndex = 0;
    let relMatch: RegExpExecArray | null;
    while ((relMatch = SQLA_REL_RE.exec(source)) !== null) {
      edges.push({
        from: sym.name,
        to: relMatch[2]!,
        field: relMatch[1]!,
        relationship: "relationship",
      });
      fields.push({ name: relMatch[1]!, type: `relationship(${relMatch[2]})` });
    }

    // Extract SQLAlchemy FK columns
    SQLA_FK_COL_RE.lastIndex = 0;
    let fkMatch: RegExpExecArray | null;
    while ((fkMatch = SQLA_FK_COL_RE.exec(source)) !== null) {
      const targetTable = fkMatch[2]!;
      // Convert table name to model name (best effort: capitalize)
      const targetModel = targetTable.charAt(0).toUpperCase() + targetTable.slice(1);
      edges.push({
        from: sym.name,
        to: targetModel,
        field: fkMatch[1]!,
        relationship: "fk",
      });
    }

    // Extract non-relationship fields
    DJANGO_FIELD_RE.lastIndex = 0;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = DJANGO_FIELD_RE.exec(source)) !== null) {
      // Skip if already captured as a relationship
      if (!fields.some((f) => f.name === fieldMatch![1])) {
        fields.push({ name: fieldMatch[1]!, type: fieldMatch[2]! });
      }
    }

    SQLA_COL_RE.lastIndex = 0;
    while ((fieldMatch = SQLA_COL_RE.exec(source)) !== null) {
      if (!fields.some((f) => f.name === fieldMatch![1])) {
        fields.push({ name: fieldMatch[1]!, type: fieldMatch[2]! });
      }
    }

    models.push({ name: sym.name, file: sym.file, fields });
  }

  const graph: ModelGraph = { models, edges, framework };

  if (options?.output_format === "mermaid") {
    return { mermaid: graphToMermaid(graph) };
  }

  return graph;
}

function graphToMermaid(graph: ModelGraph): string {
  const lines = ["erDiagram"];
  for (const model of graph.models) {
    lines.push(`  ${model.name} {`);
    for (const field of model.fields) {
      lines.push(`    ${field.type} ${field.name}`);
    }
    lines.push("  }");
  }
  for (const edge of graph.edges) {
    const rel = edge.relationship === "m2m" ? "}o--o{" :
                edge.relationship === "o2o" ? "||--||" : "||--o{";
    lines.push(`  ${edge.from} ${rel} ${edge.to} : "${edge.field}"`);
  }
  return lines.join("\n");
}
