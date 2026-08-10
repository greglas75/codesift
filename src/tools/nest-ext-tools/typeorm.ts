import { readNestSource, requireNestCodeIndex } from "./shared.js";
import { detectCycles, type NestToolError } from "../nest-tools.js";

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
  const index = await requireNestCodeIndex(repo);

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
    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;

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
