import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import { nestQueueMap } from "../../src/tools/nest-ext-tools.js";

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

describe("nest_queue_map", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-queue-"));
    await mkdir(join(tmpRoot, "src/jobs"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("extracts @Processor class with @Process/@OnQueueFailed handlers", async () => {
    await writeFile(join(tmpRoot, "src/jobs/email.processor.ts"), `
import { Processor, Process, OnQueueActive, OnQueueFailed } from '@nestjs/bull';
import { Job } from 'bullmq';

@Processor('email')
export class EmailProcessor {
  @Process()
  async handleSend(job: Job) {}

  @Process('welcome')
  async handleWelcome(job: Job) {}

  @OnQueueActive()
  onActive(job: Job) {}

  @OnQueueFailed()
  onFailed(job: Job, err: Error) {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/jobs/email.processor.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestQueueMap("test-repo");
    expect(result.processors).toHaveLength(1);
    const proc = result.processors[0]!;
    expect(proc.processor_class).toBe("EmailProcessor");
    expect(proc.queue_name).toBe("email");
    expect(proc.handlers).toHaveLength(4);
    const processes = proc.handlers.filter((h) => h.decorator === "@Process");
    expect(processes).toHaveLength(2);
    expect(processes.find((h) => h.handler === "handleWelcome")!.job_name).toBe("welcome");
    expect(proc.handlers.some((h) => h.decorator === "@OnQueueFailed")).toBe(true);
  });

  it("extracts @InjectQueue producers", async () => {
    await mkdir(join(tmpRoot, "src/mail"), { recursive: true });
    await writeFile(join(tmpRoot, "src/mail/mail.service.ts"), `
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bullmq';

@Injectable()
export class MailService {
  constructor(@InjectQueue('email') private readonly emailQueue: Queue) {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/mail/mail.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestQueueMap("test-repo");
    expect(result.producers).toHaveLength(1);
    expect(result.producers[0]!.queue_name).toBe("email");
    expect(result.producers[0]!.class_name).toBe("MailService");
  });

  it("CQ8: unreadable file appended to errors", async () => {
    const index = mockIndexWithRoot(tmpRoot, ["src/jobs/missing.processor.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestQueueMap("test-repo");
    expect(result.errors).toEqual([
      {
        file: "src/jobs/missing.processor.ts",
        reason: expect.stringMatching(/^readFile failed:/),
      },
    ]);
  });

  it("adversarial regression: respects class boundaries, object jobs, producer ownership, and exact limits", async () => {
    await writeFile(join(tmpRoot, "src/jobs/report.processor.ts"), `
@Processor('reports')
class ReportProcessor {
  // class MisleadingBoundary
  @Process({ name: 'daily', concurrency: 2 })
  daily() {}
}
class FirstProducer {
  constructor(@InjectQueue('first') first: Queue) {}
}
class SecondProducer {
  constructor(@InjectQueue('second') second: Queue) {}
}
`);
    await mkdir(join(tmpRoot, "node_modules"), { recursive: true });
    await writeFile(join(tmpRoot, "node_modules/fake.ts"), `
@Processor('dependency') class DependencyProcessor {}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/jobs/report.processor.ts", "node_modules/fake.ts"]),
    );

    const result = await nestQueueMap("test-repo", { max_processors: 1 });

    expect(result.processors).toEqual([
      expect.objectContaining({
        processor_class: "ReportProcessor",
        queue_name: "reports",
        handlers: [
          expect.objectContaining({ decorator: "@Process", handler: "daily", job_name: "daily" }),
        ],
      }),
    ]);
    expect(result.producers).toEqual(
      expect.arrayContaining([
        { class_name: "FirstProducer", queue_name: "first", file: "src/jobs/report.processor.ts" },
        { class_name: "SecondProducer", queue_name: "second", file: "src/jobs/report.processor.ts" },
      ]),
    );
    expect(result.truncated).toBeUndefined();
  });

  it("marks the result truncated when another processor exceeds the limit", async () => {
    await writeFile(join(tmpRoot, "src/jobs/multi.processor.ts"), `
@Processor('first') class FirstProcessor {}
@Processor('second') class SecondProcessor {}
`);
    mockedGetCodeIndex.mockResolvedValue(
      mockIndexWithRoot(tmpRoot, ["src/jobs/multi.processor.ts"]),
    );

    const result = await nestQueueMap("test-repo", { max_processors: 1 });

    expect(result.processors).toEqual([
      expect.objectContaining({ processor_class: "FirstProcessor", queue_name: "first" }),
    ]);
    expect(result.truncated).toBe(true);
  });
});
