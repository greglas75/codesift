import {
  findDecoratedClass,
  findDecoratorCalls,
  findNestClassRanges,
  findTopLevelStringProperty,
  firstNestDecoratorArgument,
  maskNestSource,
  readNestSource,
  requireNestCodeIndex,
  stripLeadingNestComments,
} from "./shared.js";
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

  entityFilesLoop: for (const file of entityFiles) {
    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;

    const classRanges = findNestClassRanges(source);
    for (const call of findDecoratorCalls(source, "Entity")) {
      const owner = findDecoratedClass(classRanges, call);
      if (!owner) continue;
      if (entities.length >= maxEntities) {
        truncated = true;
        break entityFilesLoop;
      }

      const firstArg = stripLeadingNestComments(firstNestDecoratorArgument(call.args));
      let tableName = /^\s*['"`]([^'"`]+)['"`]/.exec(firstArg)?.[1];
      if (!tableName) {
        tableName = findTopLevelStringProperty(firstArg, "name");
      }
      const node: NestEntityNode = { name: owner.name, file: file.path };
      if (tableName) node.table = tableName;
      entities.push(node);

      const classBody = source.slice(owner.bodyStart + 1, owner.end - 1);
      const maskedBody = maskNestSource(classBody);
      const relRe = /@(OneToMany|ManyToOne|OneToOne|ManyToMany)\s*\(\s*(?:\([^)]*\)|\w+)\s*=>\s*(\w+)/g;
      let rm: RegExpExecArray | null;
      while ((rm = relRe.exec(classBody)) !== null) {
        if (maskedBody[rm.index] !== "@") continue;
        edges.push({
          from: owner.name,
          to: rm[2]!,
          relation: rm[1]! as NestEntityEdge["relation"],
        });
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
