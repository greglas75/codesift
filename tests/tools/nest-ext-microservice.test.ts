import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { nestMicroserviceMap } from "../../src/tools/nest-ext-tools.js";

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

describe("nest_microservice_map", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-ms-"));
    await mkdir(join(tmpRoot, "src/orders"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("extracts @MessagePattern and @EventPattern handlers", async () => {
    await writeFile(join(tmpRoot, "src/orders/orders.controller.ts"), `
import { Controller } from '@nestjs/common';
import { MessagePattern, EventPattern, Payload } from '@nestjs/microservices';

@Controller()
export class OrdersController {
  @MessagePattern('create_order')
  handleCreateOrder(@Payload() data: CreateOrderDto) {}

  @EventPattern('order.shipped')
  async handleOrderShipped(@Payload() data: OrderShippedEvent) {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/orders/orders.controller.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestMicroserviceMap("test-repo");
    expect(result.patterns).toHaveLength(2);
    expect(result.patterns).toContainEqual({
      type: "MessagePattern",
      pattern: "create_order",
      handler: "handleCreateOrder",
      controller: "OrdersController",
      file: "src/orders/orders.controller.ts",
    });
    expect(result.patterns).toContainEqual({
      type: "EventPattern",
      pattern: "order.shipped",
      handler: "handleOrderShipped",
      controller: "OrdersController",
      file: "src/orders/orders.controller.ts",
    });
  });

  it("truncates when max_patterns exceeded", async () => {
    await writeFile(join(tmpRoot, "src/orders/multi.controller.ts"), `
@Controller() class Multi {
  @MessagePattern('a') handleA() {}
  @MessagePattern('b') handleB() {}
  @MessagePattern('c') handleC() {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/orders/multi.controller.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestMicroserviceMap("test-repo", { max_patterns: 2 });
    expect(result.patterns).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("stops before reading a later controller after reaching max_patterns", async () => {
    await writeFile(join(tmpRoot, "src/orders/first.controller.ts"), `
class FirstController { @MessagePattern('first') first() {} }
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, [
        "src/orders/first.controller.ts",
        "src/orders/missing.controller.ts",
      ]),
    );

    const result = await nestMicroserviceMap("test-repo", { max_patterns: 1 });

    expect(result.patterns).toEqual([
      expect.objectContaining({ handler: "first", controller: "FirstController" }),
    ]);
    expect(result.errors).toBeUndefined();
    expect(result.truncated).toBe(true);
  });

  it("CQ8: unreadable controller file appended to errors", async () => {
    const index = mockIndexWithRoot(tmpRoot, ["src/orders/missing.controller.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestMicroserviceMap("test-repo");
    expect(result.errors).toEqual([
      {
        file: "src/orders/missing.controller.ts",
        reason: expect.stringMatching(/^readFile failed:/),
      },
    ]);
  });

  it("adversarial regression: captures object and identifier patterns with class ownership", async () => {
    await writeFile(join(tmpRoot, "src/orders/patterns.controller.ts"), `
class MathController {
  @MessagePattern({ cmd: 'sum' })
  sum() {}
}
class EventsController {
  @EventPattern(ORDER_CREATED)
  created() {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/orders/patterns.controller.ts"]),
    );

    const result = await nestMicroserviceMap("test-repo");

    expect(result.patterns).toEqual([
      expect.objectContaining({
        type: "MessagePattern",
        pattern: "{ cmd: 'sum' }",
        handler: "sum",
        controller: "MathController",
      }),
      expect.objectContaining({
        type: "EventPattern",
        pattern: "ORDER_CREATED",
        handler: "created",
        controller: "EventsController",
      }),
    ]);
  });

  it("adversarial regression: captures the first argument of transport-specific patterns", async () => {
    await writeFile(join(tmpRoot, "src/orders/transport.controller.ts"), `
class TransportController {
  @MessagePattern({ cmd: 'sum' }, Transport.REDIS)
  sum() {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/orders/transport.controller.ts"]),
    );

    const result = await nestMicroserviceMap("test-repo");

    expect(result.patterns).toEqual([
      expect.objectContaining({ pattern: "{ cmd: 'sum' }", handler: "sum" }),
    ]);
  });

  it("keeps nested calls and arrays inside the first transport pattern argument", async () => {
    await writeFile(join(tmpRoot, "src/orders/nested.controller.ts"), `
class NestedController {
  @MessagePattern(createPattern(foo(1, 2), [A, B]), Transport.REDIS)
  nested() {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/orders/nested.controller.ts"]),
    );

    const result = await nestMicroserviceMap("test-repo");

    expect(result.patterns[0]!.pattern).toBe("createPattern(foo(1, 2), [A, B])");
  });

  it("keeps message handlers with intervening method decorators", async () => {
    await writeFile(join(tmpRoot, "src/orders/guarded.controller.ts"), `
class GuardedController {
  @MessagePattern('guarded')
  @UseGuards(MessageGuard)
  @UseInterceptors(TraceInterceptor)
  handleGuarded() {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/orders/guarded.controller.ts"]),
    );

    const result = await nestMicroserviceMap("test-repo");

    expect(result.patterns).toEqual([
      expect.objectContaining({ handler: "handleGuarded", pattern: "guarded" }),
    ]);
  });
});
