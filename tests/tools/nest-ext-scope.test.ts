import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { nestScopeAudit } from "../../src/tools/nest-ext-tools.js";

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

describe("nest_scope_audit", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-scope-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("detects REQUEST-scoped providers and walks consumers", async () => {
    await writeFile(join(tmpRoot, "src/request.service.ts"), `
import { Injectable, Scope } from '@nestjs/common';
@Injectable({ scope: Scope.REQUEST })
export class RequestService {
  constructor() {}
}
`);
    await writeFile(join(tmpRoot, "src/user.service.ts"), `
import { Injectable } from '@nestjs/common';
@Injectable()
export class UserService {
  constructor(private readonly reqSvc: RequestService) {}
}
`);
    await writeFile(join(tmpRoot, "src/user.controller.ts"), `
@Injectable()
export class UserController {
  constructor(private readonly userSvc: UserService) {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, [
      "src/request.service.ts",
      "src/user.service.ts",
      "src/user.controller.ts",
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestScopeAudit("test-repo");
    expect(result.request_scoped).toHaveLength(1);
    const issue = result.request_scoped[0]!;
    expect(issue.provider).toBe("RequestService");
    expect(issue.escalated_consumers).toContain("UserService");
    expect(issue.escalated_consumers).toContain("UserController");
  });

  it("returns empty when no REQUEST/TRANSIENT scopes", async () => {
    await writeFile(join(tmpRoot, "src/default.service.ts"), `
@Injectable() export class DefaultService { constructor() {} }
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/default.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestScopeAudit("test-repo");
    expect(result.request_scoped).toEqual([]);
    expect(result.transient_scoped).toEqual([]);
  });

  it("adversarial regression: uses the exact class and excludes a scoped provider from its consumers", async () => {
    await writeFile(join(tmpRoot, "src/circular.service.ts"), `
@Injectable()
class UserServiceV2 {
  constructor(other: OtherService) {}
}
@Injectable()
class UserService {
  constructor(request: RequestService) {}
}
@Injectable({ scope: Scope.REQUEST })
class RequestService {
  constructor(user: UserService) {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(mockIndexWithRoot(tmpRoot, ["src/circular.service.ts"]));

    const result = await nestScopeAudit("test-repo");
    const issue = result.request_scoped[0]!;

    expect(issue.provider).toBe("RequestService");
    expect(issue.escalated_consumers).toContain("UserService");
    expect(issue.escalated_consumers).not.toContain("RequestService");
    expect(issue.escalated_consumers).not.toContain("UserServiceV2");
  });

  it("reports transient providers and generic-container consumers", async () => {
    await writeFile(join(tmpRoot, "src/transient.service.ts"), `
@Injectable({ scope: Scope.TRANSIENT })
class TransientService {}
@Injectable()
class GenericConsumer {
  constructor(service: Promise<TransientService>) {}
}
@Injectable()
class RepositoryConsumer {
  constructor(service: Repository<TransientService>) {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/transient.service.ts"]),
    );

    const result = await nestScopeAudit("test-repo");

    expect(result.transient_scoped).toEqual([
      {
        provider: "TransientService",
        scope: "TRANSIENT",
        file: "src/transient.service.ts",
        escalated_consumers: [],
      },
    ]);
  });

  it("returns a precise read error and truncates at the provider limit", async () => {
    const index = mockIndexWithRoot(tmpRoot, [
      "src/missing.service.ts",
      "src/request.service.ts",
      "src/second.service.ts",
    ]);
    await writeFile(join(tmpRoot, "src/request.service.ts"), `
@Injectable({ scope: Scope.REQUEST }) class RequestService {}
`);
    await writeFile(join(tmpRoot, "src/second.service.ts"), `
@Injectable() class SecondService {}
`);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestScopeAudit("test-repo", { max_providers: 1 });

    expect(result.errors).toEqual([
      {
        file: "src/missing.service.ts",
        reason: expect.stringMatching(/^readFile failed:/),
      },
    ]);
    expect(result.request_scoped).toEqual([
      expect.objectContaining({ provider: "RequestService" }),
    ]);
    expect(result.truncated).toBe(true);
    expect(result.graph_incomplete).toBe(true);
  });

  it("enforces provider limits inside a file", async () => {
    await writeFile(join(tmpRoot, "src/many.service.ts"), `
@Injectable({ scope: Scope.REQUEST }) class FirstService {}
@Injectable({ scope: Scope.REQUEST }) class SecondService {}
@Injectable({ scope: Scope.REQUEST }) class ThirdService {}
`);
    mockedGetCodeIndex.mockResolvedValue(mockIndexWithRoot(tmpRoot, ["src/many.service.ts"]));

    const result = await nestScopeAudit("test-repo", { max_providers: 2 });

    expect(result.request_scoped).toHaveLength(2);
    expect(result.request_scoped.map((issue) => issue.provider)).toEqual([
      "FirstService",
      "SecondService",
    ]);
    expect(result).toEqual(expect.objectContaining({ truncated: true, graph_incomplete: true }));
  });

  it("understands aliased scopes and explicit injection tokens", async () => {
    await writeFile(join(tmpRoot, "src/aliased.service.ts"), `
@Injectable({ scope: NestScope.REQUEST })
class CacheService {}
@Injectable()
class CacheConsumer {
  constructor(@Inject(CacheService) cache: CacheContract) {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/aliased.service.ts"]),
    );

    const result = await nestScopeAudit("test-repo");

    expect(result.request_scoped).toEqual([
      expect.objectContaining({
        provider: "CacheService",
        escalated_consumers: ["CacheConsumer"],
      }),
    ]);
  });

  it("does not merge providers with the same class name across files", async () => {
    await writeFile(join(tmpRoot, "src/first.service.ts"), `
@Injectable({ scope: Scope.REQUEST }) class SharedService {}
@Injectable() class FirstConsumer {
  constructor(shared: SharedService) {}
}
`);
    await writeFile(join(tmpRoot, "src/second.service.ts"), `
@Injectable({ scope: Scope.TRANSIENT }) class SharedService {}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/first.service.ts", "src/second.service.ts"]),
    );

    const result = await nestScopeAudit("test-repo");

    expect(result.request_scoped[0]!.provider).toBe("SharedService (src/first.service.ts)");
    expect(result.request_scoped[0]!.escalated_consumers).toEqual([]);
    expect(result.transient_scoped[0]!.provider).toBe("SharedService (src/second.service.ts)");
    expect(result.graph_incomplete).toBe(true);
  });

  it("excludes dependencies and test fixtures before applying the provider limit", async () => {
    await mkdir(join(tmpRoot, "node_modules/vendor"), { recursive: true });
    await mkdir(join(tmpRoot, "tests"), { recursive: true });
    await writeFile(join(tmpRoot, "node_modules/vendor/vendor.service.ts"), `
@Injectable({ scope: Scope.REQUEST }) class VendorService {}
`);
    await writeFile(join(tmpRoot, "tests/fixture.service.ts"), `
@Injectable({ scope: Scope.REQUEST }) class FixtureService {}
`);
    await writeFile(join(tmpRoot, "src/fixture.service.e2e-spec.ts"), `
@Injectable({ scope: Scope.REQUEST }) class E2eFixtureService {}
`);
    await writeFile(join(tmpRoot, "src/app.service.ts"), `
@Injectable({ scope: Scope.REQUEST }) class AppService {}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, [
        "node_modules/vendor/vendor.service.ts",
        "tests/fixture.service.ts",
        "src/fixture.service.e2e-spec.ts",
        "src/app.service.ts",
      ]),
    );

    const result = await nestScopeAudit("test-repo", { max_providers: 1 });

    expect(result.request_scoped).toEqual([
      expect.objectContaining({ provider: "AppService" }),
    ]);
    expect(result.truncated).toBeUndefined();
  });
});
