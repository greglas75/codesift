import { readNestSource, requireNestCodeIndex } from "./shared.js";
import type { NestToolError } from "../nest-tools.js";

// ---------------------------------------------------------------------------
// Wave 3 Feature 4: nest_openapi_extract — @nestjs/swagger → OpenAPI 3.1
// ---------------------------------------------------------------------------

export interface OpenAPIOperation {
  path: string;
  method: string;
  summary?: string;
  description?: string;
  tags?: string[];
  security?: Array<{ [scheme: string]: string[] }>;
  parameters: Array<{ name: string; in: "path" | "query" | "header"; required: boolean; schema?: { type: string } }>;
  requestBody?: { content: { [mime: string]: { schema: { $ref?: string; type?: string } } } };
  responses: { [statusCode: string]: { description?: string; content?: { [mime: string]: { schema: { $ref?: string } } } } };
}

export interface OpenAPISchema {
  type: "object";
  properties: { [name: string]: { type?: string; $ref?: string; required?: boolean; description?: string; enum?: string[] } };
  required?: string[];
}

export interface NestOpenAPIResult {
  openapi: "3.1.0";
  info: { title: string; version: string };
  paths: { [path: string]: { [method: string]: OpenAPIOperation } };
  components: { schemas: { [name: string]: OpenAPISchema } };
  errors?: NestToolError[];
}

export async function nestOpenAPIExtract(
  repo: string,
  options?: { title?: string; version?: string },
): Promise<NestOpenAPIResult> {
  const index = await requireNestCodeIndex(repo);

  const errors: NestToolError[] = [];
  const paths: NestOpenAPIResult["paths"] = {};
  const schemas: NestOpenAPIResult["components"]["schemas"] = {};

  // Step 1: Extract DTO schemas from files with @ApiProperty decorators
  const allFiles = index.files.filter((f) => {
    if (!f.path.endsWith(".ts") && !f.path.endsWith(".js")) return false;
    if (/\.(spec|test)\./.test(f.path)) return false;
    return true;
  });

  for (const file of allFiles) {
    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;

    if (!/@ApiProperty/.test(source)) continue;

    // Parse DTO classes
    const classRe = /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{([\s\S]*?)^\}/gm;
    let cm: RegExpExecArray | null;
    while ((cm = classRe.exec(source)) !== null) {
      const className = cm[1]!;
      const body = cm[2]!;
      if (!/@ApiProperty/.test(body)) continue;

      const schema: OpenAPISchema = { type: "object", properties: {}, required: [] };
      // Match @ApiProperty({ ... }) followed by field: type;
      const propRe = /@ApiProperty(?:Optional)?\s*\(\s*(\{[^}]*\})?\s*\)\s*(?:(?:readonly|public|private)\s+)?(\w+)(\??)\s*:\s*(\w+(?:<[\w,\s]+>)?)/g;
      let pm: RegExpExecArray | null;
      while ((pm = propRe.exec(body)) !== null) {
        const argsStr = pm[1] ?? "";
        const fieldName = pm[2]!;
        const isOptional = pm[3] === "?";
        const tsType = pm[4]!;

        // Extract description/enum from args
        const descMatch = /description:\s*['"`]([^'"`]+)['"`]/.exec(argsStr);
        const enumMatch = /enum:\s*\[([^\]]*)\]/.exec(argsStr);

        const prop: OpenAPISchema["properties"][string] = {
          type: mapTsTypeToOpenAPI(tsType),
        };
        if (descMatch) prop.description = descMatch[1]!;
        if (enumMatch) {
          prop.enum = enumMatch[1]!
            .split(",")
            .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ""))
            .filter(Boolean);
        }

        schema.properties[fieldName] = prop;
        if (!isOptional && !/@ApiPropertyOptional/.test(pm[0])) {
          schema.required!.push(fieldName);
        }
      }

      if (Object.keys(schema.properties).length > 0) {
        if (schema.required!.length === 0) delete schema.required;
        schemas[className] = schema;
      }
    }
  }

  // Step 2: Extract routes from controllers + project @ApiOperation/@ApiResponse into paths
  const controllerFiles = index.files.filter((f) => f.path.endsWith(".controller.ts"));
  for (const file of controllerFiles) {
    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;

    // Controller prefix
    const ctrlMatch = /@Controller\s*\(\s*(?:['"`]([^'"`]*)['"`]|\{[^}]*path:\s*['"`]([^'"`]*)['"`])/.exec(source);
    const ctrlPrefix = ctrlMatch?.[1] ?? ctrlMatch?.[2] ?? "";

    // @ApiTags at class level
    const tagsMatch = /@ApiTags\s*\(\s*((?:['"`][^'"`]+['"`]\s*,?\s*)+)\)/.exec(source);
    const tags = tagsMatch
      ? [...tagsMatch[1]!.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]!)
      : undefined;

    // Each HTTP method decorator
    const methods = ["Get", "Post", "Put", "Delete", "Patch", "All", "Head", "Options"];
    for (const method of methods) {
      const methodRe = new RegExp(
        `@${method}\\s*\\(\\s*(?:['"\`]([^'"\`]*)['"\`])?\\s*\\)`,
        "g",
      );
      let mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(source)) !== null) {
        const routePath = mm[1] ?? "";
        // Scan forward 500 chars for stacked @Api* decorators + handler name
        const lookFwd = source.slice(mm.index, mm.index + 800);

        const summaryMatch = /@ApiOperation\s*\(\s*\{[^}]*summary:\s*['"`]([^'"`]+)['"`]/.exec(lookFwd);
        const descMatch = /@ApiOperation\s*\(\s*\{[^}]*description:\s*['"`]([^'"`]+)['"`]/.exec(lookFwd);
        const bearerMatch = /@ApiBearerAuth\s*\(/.test(lookFwd);

        // Collect @ApiResponse decorators
        const responses: OpenAPIOperation["responses"] = {};
        const respRe = /@ApiResponse\s*\(\s*\{\s*status:\s*(\d+)(?:[\s\S]*?description:\s*['"`]([^'"`]+)['"`])?(?:[\s\S]*?type:\s*(\w+))?/g;
        let rm: RegExpExecArray | null;
        while ((rm = respRe.exec(lookFwd)) !== null) {
          const status = rm[1]!;
          const description = rm[2];
          const type = rm[3];
          responses[status] = {
            ...(description ? { description } : {}),
            ...(type ? { content: { "application/json": { schema: { $ref: `#/components/schemas/${type}` } } } } : {}),
          };
        }
        // Default 200 if no @ApiResponse
        if (Object.keys(responses).length === 0) {
          responses["200"] = { description: "Success" };
        }

        // @Param / @Query / @Body
        const parameters: OpenAPIOperation["parameters"] = [];
        const paramRe = /@(Param|Query)\s*\(\s*['"`](\w+)['"`]\s*\)\s*(\w+)\s*:\s*(\w+)/g;
        let pm2: RegExpExecArray | null;
        while ((pm2 = paramRe.exec(lookFwd)) !== null) {
          parameters.push({
            name: pm2[2]!,
            in: pm2[1] === "Param" ? "path" : "query",
            required: pm2[1] === "Param", // path params always required
            schema: { type: mapTsTypeToOpenAPI(pm2[4]!) },
          });
        }

        let requestBody: OpenAPIOperation["requestBody"] | undefined;
        const bodyMatch = /@Body\s*\(\s*\)\s*(\w+)\s*:\s*(\w+)/.exec(lookFwd);
        if (bodyMatch) {
          requestBody = {
            content: { "application/json": { schema: { $ref: `#/components/schemas/${bodyMatch[2]}` } } },
          };
        }

        const fullPath = `/${ctrlPrefix}/${routePath}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

        if (!paths[fullPath]) paths[fullPath] = {};

        const op: OpenAPIOperation = {
          path: fullPath,
          method: method.toUpperCase(),
          parameters,
          responses,
        };
        if (summaryMatch) op.summary = summaryMatch[1]!;
        if (descMatch) op.description = descMatch[1]!;
        if (tags) op.tags = tags;
        if (bearerMatch) op.security = [{ bearer: [] }];
        if (requestBody) op.requestBody = requestBody;

        paths[fullPath]![method.toLowerCase()] = op;
      }
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: options?.title ?? "NestJS API",
      version: options?.version ?? "1.0.0",
    },
    paths,
    components: { schemas },
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/** Map TypeScript type names to OpenAPI 3.1 primitive types */
function mapTsTypeToOpenAPI(tsType: string): string {
  const normalized = tsType.replace(/<.*>/, "").trim();
  switch (normalized) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "Date": return "string";
    case "Array":
    case "any[]": return "array";
    default: return "object";
  }
}
