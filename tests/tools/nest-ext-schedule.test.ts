import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { nestScheduleMap } from "../../src/tools/nest-ext-tools.js";

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

describe("nest_schedule_map", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-sched-"));
    await mkdir(join(tmpRoot, "src/jobs"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("extracts @Cron, @Interval, @Timeout, @OnEvent handlers", async () => {
    await writeFile(join(tmpRoot, "src/jobs/billing.service.ts"), `
import { Injectable } from '@nestjs/common';
import { Cron, Interval, Timeout } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class BillingService {
  @Cron('0 0 * * *')
  async handleDailyBilling() {}

  @Interval(60000)
  handleHealthCheck() {}

  @Timeout(5000)
  handleStartup() {}

  @Timeout(0)
  handleImmediately() {}

  @OnEvent('user.created')
  async onUserCreated(payload: any) {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/jobs/billing.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestScheduleMap("test-repo");
    expect(result.entries).toHaveLength(5);

    const cron = result.entries.find((e) => e.decorator === "@Cron");
    expect(cron).toEqual(expect.objectContaining({ handler: "handleDailyBilling" }));
    expect(cron!.expression).toBe("0 0 * * *");
    expect(cron!.handler).toBe("handleDailyBilling");

    const interval = result.entries.find((e) => e.decorator === "@Interval");
    expect(interval!.interval_ms).toBe(60000);

    const timeout = result.entries.find((e) => e.decorator === "@Timeout");
    expect(timeout!.interval_ms).toBe(5000);

    const immediate = result.entries.find((e) => e.handler === "handleImmediately");
    expect(immediate).toEqual(
      expect.objectContaining({ decorator: "@Timeout", interval_ms: 0 }),
    );

    const onEvent = result.entries.find((e) => e.decorator === "@OnEvent");
    expect(onEvent!.expression).toBe("user.created");
    expect(onEvent!.handler).toBe("onUserCreated");
  });

  it("excludes test/spec files", async () => {
    await writeFile(join(tmpRoot, "src/jobs/billing.service.ts"), `
@Cron('0 0 * * *') handleDaily() {}
`);
    await writeFile(join(tmpRoot, "src/jobs/billing.spec.ts"), `
@Cron('0 0 * * *') handleDaily() {}
`);
    const index = mockIndexWithRoot(tmpRoot, [
      "src/jobs/billing.service.ts",
      "src/jobs/billing.spec.ts",
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestScheduleMap("test-repo");
    // Only production file should be scanned
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.file).toBe("src/jobs/billing.service.ts");
  });

  it("truncates when max_schedules exceeded", async () => {
    await writeFile(join(tmpRoot, "src/jobs/multi.service.ts"), `
@Cron('*/1 * * * *') handleA() {}
@Cron('*/2 * * * *') handleB() {}
@Cron('*/3 * * * *') handleC() {}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/jobs/multi.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestScheduleMap("test-repo", { max_schedules: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("stops before reading a later file after reaching max_schedules", async () => {
    await writeFile(join(tmpRoot, "src/jobs/first.service.ts"), `
class FirstJobs { @Cron('* * * * *') first() {} }
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, [
        "src/jobs/first.service.ts",
        "src/jobs/missing.service.ts",
      ]),
    );

    const result = await nestScheduleMap("test-repo", { max_schedules: 1 });

    expect(result.entries).toEqual([
      expect.objectContaining({ handler: "first", file: "src/jobs/first.service.ts" }),
    ]);
    expect(result.errors).toBeUndefined();
    expect(result.truncated).toBe(true);
  });

  it("does not scan beyond max_files_scanned", async () => {
    await writeFile(join(tmpRoot, "src/jobs/first.service.ts"), `
class FirstJobs { @Cron('* * * * *') first() {} }
`);
    await writeFile(join(tmpRoot, "src/jobs/second.service.ts"), `
class SecondJobs { @Cron('* * * * *') second() {} }
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, [
        "src/jobs/first.service.ts",
        "src/jobs/second.service.ts",
      ]),
    );

    const result = await nestScheduleMap("test-repo", { max_files_scanned: 1 });

    expect(result.entries).toEqual([
      expect.objectContaining({ handler: "first", file: "src/jobs/first.service.ts" }),
    ]);
    expect(result.truncated).toBe(true);
  });

  it("CQ8: unreadable file appended to errors", async () => {
    const index = mockIndexWithRoot(tmpRoot, ["src/jobs/missing.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestScheduleMap("test-repo");
    expect(result.errors).toEqual([
      {
        file: "src/jobs/missing.service.ts",
        reason: expect.stringMatching(/^readFile failed:/),
      },
    ]);
  });

  it("R-12: captures constant-expression args (CronExpression.EVERY_10_SECONDS)", async () => {
    await writeFile(join(tmpRoot, "src/jobs/const.service.ts"), `
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';

const HEARTBEAT_MS = 60000;

@Injectable()
export class ConstService {
  @Cron(CronExpression.EVERY_10_SECONDS)
  handleEveryTen() {}

  @Interval(HEARTBEAT_MS)
  handleHeartbeat() {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/jobs/const.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestScheduleMap("test-repo");
    // Constant expression should be captured in fallback
    const cronEntry = result.entries.find((e) => e.handler === "handleEveryTen");
    expect(cronEntry).toEqual(expect.objectContaining({ handler: "handleEveryTen" }));
    expect(cronEntry!.decorator).toBe("@Cron");
    expect(cronEntry!.expression).toBe("CronExpression.EVERY_10_SECONDS");
  });

  it("adversarial regression: maps decorators to the nearest class and parses numeric separators", async () => {
    await writeFile(join(tmpRoot, "src/jobs/multi-class.service.ts"), `
class FirstJobs {
  @Cron('0 * * * *')
  shared() {}
}
class SecondJobs {
  @Interval(HEARTBEAT_MS)
  shared() {}

  @Timeout(60_000)
  delayed() {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/jobs/multi-class.service.ts"]),
    );

    const result = await nestScheduleMap("test-repo");

    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ decorator: "@Cron", class_name: "FirstJobs", handler: "shared" }),
        expect.objectContaining({
          decorator: "@Interval",
          class_name: "SecondJobs",
          handler: "shared",
          expression: "HEARTBEAT_MS",
        }),
        expect.objectContaining({
          decorator: "@Timeout",
          class_name: "SecondJobs",
          handler: "delayed",
          interval_ms: 60000,
        }),
      ]),
    );
  });

  it("adversarial regression: preserves unsafe delay literals as expressions", async () => {
    await writeFile(join(tmpRoot, "src/jobs/unsafe.service.ts"), `
class UnsafeJobs {
  @Interval(1e999)
  overflow() {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(mockIndexWithRoot(tmpRoot, ["src/jobs/unsafe.service.ts"]));

    const result = await nestScheduleMap("test-repo");

    expect(result.entries).toEqual([
      expect.objectContaining({ handler: "overflow", expression: "1e999" }),
    ]);
    expect(result.entries[0]).not.toHaveProperty("interval_ms");
  });

  it("deduplicates constant-expression decorators on one handler", async () => {
    await writeFile(join(tmpRoot, "src/jobs/duplicate.service.ts"), `
class DuplicateJobs {
  @Interval(HEARTBEAT_MS)
  @Interval(HEARTBEAT_MS)
  heartbeat() {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/jobs/duplicate.service.ts"]),
    );

    const result = await nestScheduleMap("test-repo");

    expect(result.entries).toEqual([
      expect.objectContaining({ handler: "heartbeat", expression: "HEARTBEAT_MS" }),
    ]);
  });

  it("supports named delays and intervening method decorators", async () => {
    await writeFile(join(tmpRoot, "src/jobs/named.service.ts"), `
class NamedJobs {
  @Interval('health-check', 5_000)
  @UseGuards(JobGuard)
  health() {}

  @Timeout('bootstrap', BOOTSTRAP_DELAY)
  @UseInterceptors(TraceInterceptor)
  bootstrap() {}
}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/jobs/named.service.ts"]),
    );

    const result = await nestScheduleMap("test-repo");

    expect(result.entries).toEqual([
      expect.objectContaining({ handler: "health", interval_ms: 5000 }),
      expect.objectContaining({ handler: "bootstrap", expression: "BOOTSTRAP_DELAY" }),
    ]);
  });
});
