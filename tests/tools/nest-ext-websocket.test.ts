import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { nestWebSocketMap } from "../../src/tools/nest-ext-tools.js";

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

describe("nest_websocket_map", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-ws-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("extracts gateway with port, namespace, and event handlers", async () => {
    await writeFile(join(tmpRoot, "src/chat.gateway.ts"), `
import { WebSocketGateway, SubscribeMessage, MessageBody } from '@nestjs/websockets';

@WebSocketGateway(3001, { namespace: '/chat', cors: true })
export class ChatGateway {
  @SubscribeMessage('message')
  handleMessage(@MessageBody() data: string) {}

  @SubscribeMessage('join')
  handleJoin() {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/chat.gateway.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestWebSocketMap("test-repo");
    expect(result.gateways).toHaveLength(1);
    const gw = result.gateways[0]!;
    expect(gw.gateway_class).toBe("ChatGateway");
    expect(gw.port).toBe(3001);
    expect(gw.namespace).toBe("/chat");
    expect(gw.events).toHaveLength(2);
    expect(gw.events).toContainEqual({ event: "message", handler: "handleMessage" });
    expect(gw.events).toContainEqual({ event: "join", handler: "handleJoin" });
  });

  it("CQ8: unreadable gateway file appended to errors", async () => {
    const index = mockIndexWithRoot(tmpRoot, ["src/missing.gateway.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestWebSocketMap("test-repo");
    expect(result.gateways).toEqual([]);
    expect(result.errors).toEqual([
      {
        file: "src/missing.gateway.ts",
        reason: expect.stringMatching(/^readFile failed:/),
      },
    ]);
  });

  it("returns empty gateways when no gateway files", async () => {
    const index = mockIndexWithRoot(tmpRoot, []);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestWebSocketMap("test-repo");
    expect(result.gateways).toEqual([]);
  });

  it("truncates before a second gateway and omits absent gateway options", async () => {
    await writeFile(join(tmpRoot, "src/multi.gateway.ts"), `
@WebSocketGateway()
class FirstGateway {}
@WebSocketGateway()
class SecondGateway {}
`);
    mockedGetCodeIndex.mockResolvedValue(mockIndexWithRoot(tmpRoot, ["src/multi.gateway.ts"]));

    const result = await nestWebSocketMap("test-repo", { max_gateways: 1 });

    expect(result.gateways).toEqual([
      { gateway_class: "FirstGateway", file: "src/multi.gateway.ts", events: [] },
    ]);
    expect(result.truncated).toBe(true);
  });

  it("stops before reading a later gateway after reaching max_gateways", async () => {
    await writeFile(join(tmpRoot, "src/first.gateway.ts"), `
@WebSocketGateway() class FirstGateway {}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, [
        "src/first.gateway.ts",
        "src/missing.gateway.ts",
      ]),
    );

    const result = await nestWebSocketMap("test-repo", { max_gateways: 1 });

    expect(result.gateways).toEqual([
      expect.objectContaining({ gateway_class: "FirstGateway", file: "src/first.gateway.ts" }),
    ]);
    expect(result.errors).toBeUndefined();
    expect(result.truncated).toBe(true);
  });

  it("adversarial regression: ignores commented gateways and permits intervening class decorators", async () => {
    await writeFile(join(tmpRoot, "src/guarded.gateway.ts"), `
// @WebSocketGateway() class RemovedGateway {}
@WebSocketGateway({ namespace: '/guarded' })
@UseGuards(WsAuthGuard)
export class GuardedGateway {
  @SubscribeMessage('ping')
  ping() {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(mockIndexWithRoot(tmpRoot, ["src/guarded.gateway.ts"]));

    const result = await nestWebSocketMap("test-repo");

    expect(result.gateways).toEqual([
      expect.objectContaining({
        gateway_class: "GuardedGateway",
        namespace: "/guarded",
        events: [{ event: "ping", handler: "ping" }],
      }),
    ]);
  });
});
