import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { nestOpenAPIExtract } from "../../src/tools/nest-ext-tools.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

beforeEach(() => {
  mockedGetCodeIndex.mockReset();
});

afterEach(() => {
  expect(mockedGetCodeIndex).toHaveBeenCalledTimes(1);
  expect(mockedGetCodeIndex).toHaveBeenCalledWith("test-repo");
  expect(mockedGetCodeIndex).not.toHaveBeenCalledWith("other-repo");
});

function mockIndexWithRoot(root: string, filePaths: string[]): CodeIndex {
  return {
    root,
    files: filePaths.map((p) => ({ path: p, size: 100 })),
    symbols: [],
  } as unknown as CodeIndex;
}

describe("nest_openapi_extract", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-openapi-"));
    await mkdir(join(tmpRoot, "src/users"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("extracts OpenAPI spec from @ApiProperty DTOs + @ApiOperation routes", async () => {
    await writeFile(join(tmpRoot, "src/users/create-user.dto.ts"), `
import { ApiProperty } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({ description: 'User name' })
  readonly name: string;

  @ApiProperty({ description: 'User email' })
  readonly email: string;

  @ApiProperty({ enum: ['admin', 'user'] })
  readonly role?: string;
}
`);
    await writeFile(join(tmpRoot, "src/users/users.controller.ts"), `
import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { CreateUserDto } from './create-user.dto';

@ApiTags('users')
@Controller('users')
export class UsersController {
  @Get(':id')
  @ApiOperation({ summary: 'Get user by id' })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'User found', type: CreateUserDto })
  findOne(@Param('id') id: string) {}

  @Post()
  @ApiOperation({ summary: 'Create new user' })
  create(@Body() dto: CreateUserDto) {}
}
`);

    const index = mockIndexWithRoot(tmpRoot, [
      "src/users/create-user.dto.ts",
      "src/users/users.controller.ts",
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestOpenAPIExtract("test-repo", { title: "Test API", version: "2.0.0" });

    expect(result.openapi).toBe("3.1.0");
    expect(result.info.title).toBe("Test API");

    // Schema
    expect(result.components.schemas.CreateUserDto).toEqual(
      expect.objectContaining({ required: expect.arrayContaining(["name"]) }),
    );
    expect(result.components.schemas.CreateUserDto!.properties.name).toEqual(
      expect.objectContaining({ type: "string" }),
    );
    expect(result.components.schemas.CreateUserDto!.properties.name!.description).toBe("User name");
    expect(result.components.schemas.CreateUserDto!.properties.role!.enum).toEqual(["admin", "user"]);

    // Paths
    expect(result.paths["/users/{id}"]).toEqual(
      expect.objectContaining({ get: expect.any(Object) }),
    );
    expect(result.paths["/users/{id}"]!.get!.summary).toBe("Get user by id");
    expect(result.paths["/users/{id}"]!.get!.tags).toContain("users");
    expect(result.paths["/users/{id}"]!.get!.security).toEqual([{ bearer: [] }]);

    expect(result.paths["/users"]).toEqual(expect.objectContaining({ post: expect.any(Object) }));
    expect(result.paths["/users"]!.post!.summary).toBe("Create new user");
    expect(result.paths["/users"]!.post!.requestBody).toEqual({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/CreateUserDto" },
        },
      },
    });
  });

  it("returns empty paths when no controllers have Swagger decorators", async () => {
    const index = mockIndexWithRoot(tmpRoot, []);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestOpenAPIExtract("test-repo");
    expect(result.paths).toEqual({});
    expect(result.components.schemas).toEqual({});
  });

  it("adversarial regression: bounds route metadata and emits only valid OpenAPI methods", async () => {
    await writeFile(join(tmpRoot, "src/users/metadata.controller.ts"), `
@Controller('metadata')
class MetadataController {
  @Get('plain')
  plain() {}

  @Post('documented')
  @ApiOperation({ summary: 'Documented only' })
  @ApiResponse({ status: 403 })
  @ApiResponse({ status: 200, description: 'Created', type: CreateUserDto })
  documented() {}

  @All('catch-all')
  catchAll() {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/users/metadata.controller.ts"]),
    );

    const result = await nestOpenAPIExtract("test-repo");

    expect(result.paths["/metadata/plain"]!.get!.summary).toBeUndefined();
    expect(result.paths["/metadata/documented"]!.post!.responses["403"]).toEqual({});
    expect(result.paths["/metadata/documented"]!.post!.responses["200"]).toEqual({
      description: "Created",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/CreateUserDto" },
        },
      },
    });
    expect(Object.keys(result.paths["/metadata/catch-all"]!)).toEqual([
      "get",
      "post",
      "put",
      "delete",
      "patch",
      "head",
      "options",
    ]);
  });

  it("adversarial regression: does not read parameter decorators from handler bodies", async () => {
    await writeFile(join(tmpRoot, "src/users/body.controller.ts"), `
@Controller('body')
class BodyController {
  @Get('safe')
  safe() {
    const example = "@Query('fake') fake: string";
    return example;
  }
}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/users/body.controller.ts"]),
    );

    const result = await nestOpenAPIExtract("test-repo");

    expect(result.paths["/body/safe"]!.get!.parameters).toEqual([]);
  });

  it("maps primitive, array, date, and object DTO types", async () => {
    await writeFile(join(tmpRoot, "src/users/types.dto.ts"), `
class TypesDto {
  @ApiProperty() count: number;
  @ApiProperty() enabled: boolean;
  @ApiProperty() createdAt: Date;
  @ApiProperty() names: Array<string>;
  @ApiPropertyOptional() metadata?: Metadata;
}
`);
    mockedGetCodeIndex.mockResolvedValue(mockIndexWithRoot(tmpRoot, ["src/users/types.dto.ts"]));

    const result = await nestOpenAPIExtract("test-repo");

    expect(result.components.schemas.TypesDto).toEqual({
      type: "object",
      properties: {
        count: { type: "number" },
        enabled: { type: "boolean" },
        createdAt: { type: "string" },
        names: { type: "array" },
        metadata: { type: "object" },
      },
      required: ["count", "enabled", "createdAt", "names"],
    });
  });

  it("returns precise read errors for missing OpenAPI source files", async () => {
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/users/missing.controller.ts"]),
    );

    const result = await nestOpenAPIExtract("test-repo");

    expect(result.errors).toEqual([
      {
        file: "src/users/missing.controller.ts",
        reason: expect.stringMatching(/^readFile failed:/),
      },
      {
        file: "src/users/missing.controller.ts",
        reason: expect.stringMatching(/^readFile failed:/),
      },
    ]);
  });
});
