import {
  findDecoratorCalls,
  findNestClassRanges,
  findClassAtPosition,
  findNestDecoratorBlockStart,
  findNestMethodAfter,
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
  properties: { [name: string]: { type?: string; $ref?: string; items?: { type?: string; $ref?: string }; required?: boolean; description?: string; enum?: string[] } };
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
      const propertyCalls = (["ApiProperty", "ApiPropertyOptional"] as const)
        .flatMap((decorator) =>
          findDecoratorCalls(body, decorator).map((call) => ({ ...call, decorator })),
        )
        .sort((left, right) => left.start - right.start);
      for (const propertyCall of propertyCalls) {
        const fieldMatch = /^\s*(?:(?:readonly|public|private|protected|static)\s+)*(\w+)(\??)\s*:\s*([^;=\n]+)/.exec(
          body.slice(propertyCall.end),
        );
        if (!fieldMatch) continue;
        const argsStr = propertyCall.args;
        const fieldName = fieldMatch[1]!;
        const isOptional = fieldMatch[2] === "?" || propertyCall.decorator === "ApiPropertyOptional";
        const tsType = fieldMatch[3]!.trim();

        // Extract description/enum from args
        const descMatch = /description:\s*['"`]([^'"`]+)['"`]/.exec(argsStr);
        const enumMatch = /enum:\s*\[([^\]]*)\]/.exec(argsStr);

        const prop: OpenAPISchema["properties"][string] = mapTsTypeToOpenAPISchema(tsType);
        if (descMatch) prop.description = descMatch[1]!;
        if (enumMatch) {
          prop.enum = enumMatch[1]!
            .split(",")
            .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ""))
            .filter(Boolean);
        }

        schema.properties[fieldName] = prop;
        if (!isOptional) {
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
  const controllerFiles = index.files.filter(
    (f) => f.path.endsWith(".controller.ts") || f.path.endsWith(".controller.js"),
  );
  for (const file of controllerFiles) {
    const source = await readNestSource(index, file.path, errors);
    if (source === undefined) continue;

    const openApiMethods = ["Get", "Post", "Put", "Delete", "Patch", "Head", "Options"];
    const methods = [...openApiMethods, "All"];
    const masked = maskNestSource(source);
    const classRanges = findNestClassRanges(source);
    const routeMatches: Array<{
      method: string;
      index: number;
      end: number;
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
          end: methodMatch.index + methodMatch[0].length,
          routePath: methodMatch[1] ?? "",
        });
      }
    }
    routeMatches.sort((left, right) => left.index - right.index);

    for (const route of routeMatches) {
      const owner = findClassAtPosition(classRanges, route.index);
      const method = findNestMethodAfter(source, route.end);
      if (!owner || !method || method.start >= owner.end) {
        errors.push({ file: file.path, reason: `Could not resolve handler for @${route.method} at offset ${route.index}` });
        continue;
      }
      const ownerIndex = classRanges.indexOf(owner);
      const classLowerBound = ownerIndex > 0 ? classRanges[ownerIndex - 1]!.end : 0;
      const classDeclarationStart = source.lastIndexOf("\n", owner.start - 1) + 1;
      const classBlockStart = findNestDecoratorBlockStart(source, classDeclarationStart, classLowerBound);
      const classDecorators = source.slice(classBlockStart, owner.bodyStart);
      const ctrlArgs = findDecoratorCalls(classDecorators, "Controller")[0]?.args ?? "";
      const ctrlMatch = /^\s*(?:['"`]([^'"`]*)['"`]|\{[\s\S]*?\bpath:\s*['"`]([^'"`]*)['"`])/.exec(ctrlArgs);
      const ctrlPrefix = ctrlMatch?.[1] ?? ctrlMatch?.[2] ?? "";
      const tagsArgs = findDecoratorCalls(classDecorators, "ApiTags")[0]?.args;
      const tags = tagsArgs
        ? [...tagsArgs.matchAll(/['"`]([^'"`]+)['"`]/g)].map((match) => match[1]!)
        : undefined;
      const classBearerAuth = findDecoratorCalls(classDecorators, "ApiBearerAuth").length > 0;

      const blockStart = findNestDecoratorBlockStart(source, route.index, owner.bodyStart + 1);
      const methodHeader = /^[\s\S]*?\)\s*(?::[^\n{]+)?\s*\{/.exec(source.slice(method.start));
      if (!methodHeader) {
        errors.push({ file: file.path, reason: `Could not parse handler ${method.name} for @${route.method}` });
        continue;
      }
      const lookFwd = source.slice(blockStart, method.start + methodHeader[0].length);
      const maskedLookFwd = maskNestSource(lookFwd);
      const operationArgs = findDecoratorCalls(lookFwd, "ApiOperation")[0]?.args ?? "";
      const summary = /\bsummary:\s*['"`]([^'"`]+)['"`]/.exec(operationArgs)?.[1];
      const description = /\bdescription:\s*['"`]([^'"`]+)['"`]/.exec(operationArgs)?.[1];
      const bearerAuth = classBearerAuth || findDecoratorCalls(lookFwd, "ApiBearerAuth").length > 0;

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
      const specializedResponses: Record<string, string> = {
        ApiOkResponse: "200", ApiCreatedResponse: "201", ApiAcceptedResponse: "202",
        ApiNoContentResponse: "204", ApiBadRequestResponse: "400",
        ApiUnauthorizedResponse: "401", ApiForbiddenResponse: "403",
        ApiNotFoundResponse: "404", ApiConflictResponse: "409",
        ApiUnprocessableEntityResponse: "422", ApiTooManyRequestsResponse: "429",
        ApiInternalServerErrorResponse: "500", ApiBadGatewayResponse: "502",
        ApiServiceUnavailableResponse: "503", ApiGatewayTimeoutResponse: "504",
      };
      for (const [decorator, status] of Object.entries(specializedResponses)) {
        for (const responseCall of findDecoratorCalls(lookFwd, decorator)) {
          const responseDescription =
            /\bdescription:\s*['"`]([^'"`]+)['"`]/.exec(responseCall.args)?.[1];
          const responseType = /\btype:\s*(\w+)/.exec(responseCall.args)?.[1];
          responses[status] = {
            ...(responseDescription ? { description: responseDescription } : {}),
            ...(responseType
              ? { content: { "application/json": { schema: { $ref: `#/components/schemas/${responseType}` } } } }
              : {}),
          };
        }
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
          schema: { type: mapTsTypeToOpenAPISchema(parameterMatch[4]!).type ?? "object" },
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

        const methodKey = emittedMethod.toLowerCase();
        if (paths[fullPath]![methodKey]) {
          errors.push({ file: file.path, reason: `Duplicate OpenAPI operation ${emittedMethod.toUpperCase()} ${fullPath}` });
          continue;
        }
        paths[fullPath]![methodKey] = operation;
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
function mapTsTypeToOpenAPISchema(tsType: string): { type?: string; $ref?: string; items?: { type?: string; $ref?: string } } {
  const arraySuffix = /^(.+?)\[\]$/.exec(tsType.trim());
  const arrayGeneric = /^Array\s*<\s*(.+)\s*>$/.exec(tsType.trim());
  const itemType = arraySuffix?.[1] ?? arrayGeneric?.[1];
  if (itemType) {
    return { type: "array", items: mapTsTypeToOpenAPISchema(itemType) };
  }
  const normalized = tsType.trim();
  switch (normalized) {
    case "string": return { type: "string" };
    case "number": return { type: "number" };
    case "boolean": return { type: "boolean" };
    case "Date": return { type: "string" };
    case "unknown":
    case "any": return { type: "object" };
    default: return { $ref: `#/components/schemas/${normalized}` };
  }
}
