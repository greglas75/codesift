import {
  findDecoratorCalls,
  maskNestSource,
  readNestSource,
  requireNestCodeIndex,
} from "./shared.js";
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

    const openApiMethods = ["Get", "Post", "Put", "Delete", "Patch", "Head", "Options"];
    const methods = [...openApiMethods, "All"];
    const masked = maskNestSource(source);
    const routeMatches: Array<{
      method: string;
      index: number;
      routePath: string;
    }> = [];

    for (const method of methods) {
      const methodRe = new RegExp(
        `@${method}\\s*\\(\\s*(?:['"\\x60]([^'"\\x60]*)['"\\x60])?\\s*\\)`,
        "g",
      );
      let methodMatch: RegExpExecArray | null;
      while ((methodMatch = methodRe.exec(source)) !== null) {
        if (masked[methodMatch.index] !== "@") continue;
        routeMatches.push({
          method,
          index: methodMatch.index,
          routePath: methodMatch[1] ?? "",
        });
      }
    }
    routeMatches.sort((left, right) => left.index - right.index);

    for (const [routeIndex, route] of routeMatches.entries()) {
      const nextRoute = routeMatches[routeIndex + 1];
      const routeSlice = source.slice(route.index, nextRoute?.index ?? source.length);
      const handlerMatch =
        /(?:^|\n)\s*(?:(?:public|private|protected|static)\s+)?(?:async\s+)?\w+\s*\([\s\S]*?\)\s*(?::[^\n{]+)?\s*\{/m.exec(
          routeSlice,
        );
      const lookFwd = handlerMatch
        ? routeSlice.slice(0, handlerMatch.index + handlerMatch[0].length)
        : routeSlice;
      const maskedLookFwd = maskNestSource(lookFwd);
      const operationArgs = findDecoratorCalls(lookFwd, "ApiOperation")[0]?.args ?? "";
      const summary = /\bsummary:\s*['"`]([^'"`]+)['"`]/.exec(operationArgs)?.[1];
      const description = /\bdescription:\s*['"`]([^'"`]+)['"`]/.exec(operationArgs)?.[1];
      const bearerAuth = findDecoratorCalls(lookFwd, "ApiBearerAuth").length > 0;

      const responses: OpenAPIOperation["responses"] = {};
      for (const responseCall of findDecoratorCalls(lookFwd, "ApiResponse")) {
        const status = /\bstatus:\s*(\d+)/.exec(responseCall.args)?.[1];
        if (!status) continue;
        const responseDescription =
          /\bdescription:\s*['"`]([^'"`]+)['"`]/.exec(responseCall.args)?.[1];
        const responseType = /\btype:\s*(\w+)/.exec(responseCall.args)?.[1];
        responses[status] = {
          ...(responseDescription ? { description: responseDescription } : {}),
          ...(responseType
            ? {
                content: {
                  "application/json": {
                    schema: { $ref: `#/components/schemas/${responseType}` },
                  },
                },
              }
            : {}),
        };
      }
      if (Object.keys(responses).length === 0) {
        responses["200"] = { description: "Success" };
      }

      const parameters: OpenAPIOperation["parameters"] = [];
      const paramRe = /@(Param|Query)\s*\(\s*['"`](\w+)['"`]\s*\)\s*(\w+)\s*:\s*(\w+)/g;
      let parameterMatch: RegExpExecArray | null;
      while ((parameterMatch = paramRe.exec(lookFwd)) !== null) {
        if (maskedLookFwd[parameterMatch.index] !== "@") continue;
        parameters.push({
          name: parameterMatch[2]!,
          in: parameterMatch[1] === "Param" ? "path" : "query",
          required: parameterMatch[1] === "Param",
          schema: { type: mapTsTypeToOpenAPI(parameterMatch[4]!) },
        });
      }

      let requestBody: OpenAPIOperation["requestBody"] | undefined;
      const bodyMatch = /@Body\s*\(\s*\)\s*(\w+)\s*:\s*(\w+)/.exec(lookFwd);
      if (bodyMatch && maskedLookFwd[bodyMatch.index] === "@") {
        requestBody = {
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${bodyMatch[2]}` },
            },
          },
        };
      }

      const fullPath =
        `/${ctrlPrefix}/${route.routePath}`
          .replace(/\/+/g, "/")
          .replace(/:([A-Za-z_]\w*)/g, "{$1}")
          .replace(/\/$/, "") || "/";

      if (!paths[fullPath]) paths[fullPath] = {};
      const emittedMethods = route.method === "All" ? openApiMethods : [route.method];
      for (const emittedMethod of emittedMethods) {
        const operation: OpenAPIOperation = {
          path: fullPath,
          method: emittedMethod.toUpperCase(),
          parameters,
          responses,
        };
        if (summary) operation.summary = summary;
        if (description) operation.description = description;
        if (tags) operation.tags = tags;
        if (bearerAuth) operation.security = [{ bearer: [] }];
        if (requestBody) operation.requestBody = requestBody;

        paths[fullPath]![emittedMethod.toLowerCase()] = operation;
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
