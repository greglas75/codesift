import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodeIndex } from "../../src/types.js";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { getCodeIndex } from "../../src/tools/index-tools.js";
import {
  nestGraphQLMap,
  nestWebSocketMap,
  nestScheduleMap,
  nestTypeOrmMap,
  nestMicroserviceMap,
  nestQueueMap,
  nestScopeAudit,
  nestOpenAPIExtract,
} from "../../src/tools/nest-ext-tools.js";

const mockedGetCodeIndex = vi.mocked(getCodeIndex);

function mockIndexWithRoot(root: string, filePaths: string[]): CodeIndex {
  return {
    root,
    files: filePaths.map((p) => ({ path: p, size: 100 })),
    symbols: [],
  } as unknown as CodeIndex;
}

// ---------------------------------------------------------------------------
// G5: nest_graphql_map
// ---------------------------------------------------------------------------

describe("nest_graphql_map", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-gql-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("extracts Query, Mutation, Subscription handlers", async () => {
    await writeFile(join(tmpRoot, "src/article.resolver.ts"), `
import { Resolver, Query, Mutation, Subscription, Args } from '@nestjs/graphql';
import { Article } from './article.entity';

@Resolver(() => Article)
export class ArticleResolver {
  @Query(() => [Article])
  async articles() { return []; }

  @Mutation(() => Article)
  async createArticle(@Args('input') input: CreateArticleInput) {}

  @Subscription(() => Article)
  articleCreated() {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/article.resolver.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestGraphQLMap("test-repo");
    expect(result.entries.length).toBe(3);
    expect(result.entries.find((e) => e.handler === "articles")!.operation).toBe("Query");
    expect(result.entries.find((e) => e.handler === "createArticle")!.operation).toBe("Mutation");
    expect(result.entries.find((e) => e.handler === "articleCreated")!.operation).toBe("Subscription");
    // All resolved to ArticleResolver class
    expect(result.entries.every((e) => e.resolver_class === "ArticleResolver")).toBe(true);
    // Return type extracted
    expect(result.entries.find((e) => e.handler === "articles")!.return_type).toBe("Article");
  });

  it("returns empty entries for repo with no resolvers", async () => {
    const index = mockIndexWithRoot(tmpRoot, []);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestGraphQLMap("test-repo");
    expect(result.entries).toEqual([]);
  });

  it("truncates when max_entries exceeded", async () => {
    await writeFile(join(tmpRoot, "src/a.resolver.ts"), `
@Resolver() export class AResolver {
  @Query() a() {}
  @Query() b() {}
  @Query() c() {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/a.resolver.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestGraphQLMap("test-repo", { max_entries: 2 });
    expect(result.entries.length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("CQ8: unreadable file appended to errors", async () => {
    const index = mockIndexWithRoot(tmpRoot, ["src/missing.resolver.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestGraphQLMap("test-repo");
    expect(result.entries).toEqual([]);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// G6: nest_websocket_map
// ---------------------------------------------------------------------------

describe("nest_websocket_map", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-ws-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
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
    expect(result.gateways.length).toBe(1);
    const gw = result.gateways[0]!;
    expect(gw.gateway_class).toBe("ChatGateway");
    expect(gw.port).toBe(3001);
    expect(gw.namespace).toBe("/chat");
    expect(gw.events.length).toBe(2);
    expect(gw.events).toContainEqual({ event: "message", handler: "handleMessage" });
    expect(gw.events).toContainEqual({ event: "join", handler: "handleJoin" });
  });

  it("CQ8: unreadable gateway file appended to errors", async () => {
    const index = mockIndexWithRoot(tmpRoot, ["src/missing.gateway.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestWebSocketMap("test-repo");
    expect(result.gateways).toEqual([]);
    expect(result.errors!.length).toBe(1);
  });

  it("returns empty gateways when no gateway files", async () => {
    const index = mockIndexWithRoot(tmpRoot, []);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestWebSocketMap("test-repo");
    expect(result.gateways).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// G7+G8: nest_schedule_map
// ---------------------------------------------------------------------------

describe("nest_schedule_map", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-sched-"));
    await mkdir(join(tmpRoot, "src/jobs"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
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

  @OnEvent('user.created')
  async onUserCreated(payload: any) {}
}
`);
    const index = mockIndexWithRoot(tmpRoot, ["src/jobs/billing.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestScheduleMap("test-repo");
    expect(result.entries.length).toBe(4);

    const cron = result.entries.find((e) => e.decorator === "@Cron");
    expect(cron).toBeDefined();
    expect(cron!.expression).toBe("0 0 * * *");
    expect(cron!.handler).toBe("handleDailyBilling");

    const interval = result.entries.find((e) => e.decorator === "@Interval");
    expect(interval!.interval_ms).toBe(60000);

    const timeout = result.entries.find((e) => e.decorator === "@Timeout");
    expect(timeout!.interval_ms).toBe(5000);

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
    expect(result.entries.length).toBe(1);
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
    expect(result.entries.length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("CQ8: unreadable file appended to errors", async () => {
    const index = mockIndexWithRoot(tmpRoot, ["src/jobs/missing.service.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestScheduleMap("test-repo");
    expect(result.errors!.length).toBe(1);
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
    expect(cronEntry).toBeDefined();
    expect(cronEntry!.decorator).toBe("@Cron");
    expect(cronEntry!.expression).toBe("CronExpression.EVERY_10_SECONDS");
  });
});

// ---------------------------------------------------------------------------
// G12: nest_typeorm_map
// ---------------------------------------------------------------------------

describe("nest_typeorm_map", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-typeorm-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("extracts entities with table names and relation edges", async () => {
    await writeFile(join(tmpRoot, "src/article.entity.ts"), `
import { Entity, PrimaryGeneratedColumn, Column, OneToMany, ManyToOne } from 'typeorm';

@Entity('articles')
export class Article {
  @PrimaryGeneratedColumn() id: number;
  @Column() title: string;
  @OneToMany(() => Comment, c => c.article) comments: Comment[];
  @ManyToOne(() => User, u => u.articles) author: User;
}
`);
    await writeFile(join(tmpRoot, "src/comment.entity.ts"), `
@Entity()
export class Comment {
  @ManyToOne(() => Article, a => a.comments) article: Article;
  @ManyToOne(() => User, u => u.comments) user: User;
}
`);
    await writeFile(join(tmpRoot, "src/user.entity.ts"), `
@Entity('users')
export class User {
  @OneToMany(() => Article, a => a.author) articles: Article[];
  @OneToMany(() => Comment, c => c.user) comments: Comment[];
}
`);

    const index = mockIndexWithRoot(tmpRoot, [
      "src/article.entity.ts",
      "src/comment.entity.ts",
      "src/user.entity.ts",
    ]);
    mockedGetCodeIndex.mockResolvedValue(index);

    const result = await nestTypeOrmMap("test-repo");
    expect(result.entities.length).toBe(3);
    expect(result.entities.find((e) => e.name === "Article")!.table).toBe("articles");
    expect(result.entities.find((e) => e.name === "User")!.table).toBe("users");
    expect(result.entities.find((e) => e.name === "Comment")!.table).toBeUndefined();

    // Edges
    expect(result.edges).toContainEqual({ from: "Article", to: "Comment", relation: "OneToMany" });
    expect(result.edges).toContainEqual({ from: "Article", to: "User", relation: "ManyToOne" });
    expect(result.edges).toContainEqual({ from: "Comment", to: "Article", relation: "ManyToOne" });
    expect(result.edges).toContainEqual({ from: "User", to: "Article", relation: "OneToMany" });

    // Cycles: Article ↔ Comment and Article ↔ User create cycles
    expect(result.cycles.length).toBeGreaterThan(0);
  });

  it("truncates when max_entities exceeded", async () => {
    await writeFile(join(tmpRoot, "src/a.entity.ts"), `@Entity() class A {}`);
    await writeFile(join(tmpRoot, "src/b.entity.ts"), `@Entity() class B {}`);
    const index = mockIndexWithRoot(tmpRoot, ["src/a.entity.ts", "src/b.entity.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestTypeOrmMap("test-repo", { max_entities: 1 });
    expect(result.entities.length).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("CQ8: unreadable entity file appended to errors", async () => {
    const index = mockIndexWithRoot(tmpRoot, ["src/missing.entity.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestTypeOrmMap("test-repo");
    expect(result.errors!.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// G14: nest_microservice_map
// ---------------------------------------------------------------------------

describe("nest_microservice_map", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-ms-"));
    await mkdir(join(tmpRoot, "src/orders"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
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
    expect(result.patterns.length).toBe(2);
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
    expect(result.patterns.length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("CQ8: unreadable controller file appended to errors", async () => {
    const index = mockIndexWithRoot(tmpRoot, ["src/orders/missing.controller.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestMicroserviceMap("test-repo");
    expect(result.errors!.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Wave 3 Feature 2: nest_queue_map (Bull/BullMQ)
// ---------------------------------------------------------------------------

describe("nest_queue_map", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-queue-"));
    await mkdir(join(tmpRoot, "src/jobs"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
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
    expect(result.processors.length).toBe(1);
    const proc = result.processors[0]!;
    expect(proc.processor_class).toBe("EmailProcessor");
    expect(proc.queue_name).toBe("email");
    expect(proc.handlers.length).toBe(4);
    const processes = proc.handlers.filter((h) => h.decorator === "@Process");
    expect(processes.length).toBe(2);
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
    expect(result.producers.length).toBe(1);
    expect(result.producers[0]!.queue_name).toBe("email");
    expect(result.producers[0]!.class_name).toBe("MailService");
  });

  it("CQ8: unreadable file appended to errors", async () => {
    const index = mockIndexWithRoot(tmpRoot, ["src/jobs/missing.processor.ts"]);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestQueueMap("test-repo");
    expect(result.errors).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Wave 3 Feature 3: nest_scope_audit (Request scope escalation)
// ---------------------------------------------------------------------------

describe("nest_scope_audit", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-scope-"));
    await mkdir(join(tmpRoot, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
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
    expect(result.request_scoped.length).toBe(1);
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
});

// ---------------------------------------------------------------------------
// Wave 3 Feature 4: nest_openapi_extract (@nestjs/swagger → OpenAPI 3.1)
// ---------------------------------------------------------------------------

describe("nest_openapi_extract", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "nest-openapi-"));
    await mkdir(join(tmpRoot, "src/users"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
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
    expect(result.components.schemas.CreateUserDto).toBeDefined();
    expect(result.components.schemas.CreateUserDto!.properties.name).toBeDefined();
    expect(result.components.schemas.CreateUserDto!.properties.name!.description).toBe("User name");
    expect(result.components.schemas.CreateUserDto!.properties.role!.enum).toEqual(["admin", "user"]);

    // Paths
    expect(result.paths["/users/:id"]).toBeDefined();
    expect(result.paths["/users/:id"]!.get!.summary).toBe("Get user by id");
    expect(result.paths["/users/:id"]!.get!.tags).toContain("users");
    expect(result.paths["/users/:id"]!.get!.security).toEqual([{ bearer: [] }]);

    expect(result.paths["/users"]).toBeDefined();
    expect(result.paths["/users"]!.post!.summary).toBe("Create new user");
    expect(result.paths["/users"]!.post!.requestBody).toBeDefined();
  });

  it("returns empty paths when no controllers have Swagger decorators", async () => {
    const index = mockIndexWithRoot(tmpRoot, []);
    mockedGetCodeIndex.mockResolvedValue(index);
    const result = await nestOpenAPIExtract("test-repo");
    expect(result.paths).toEqual({});
    expect(result.components.schemas).toEqual({});
  });
});
