import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── SDK mocks (hoisted) ──────────────────────────────────────────────────────
const anthropicCreate = vi.fn();
const openaiCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreate },
  })),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreate } },
  })),
}));

// Import after mocks so dynamic import inside providers sees them.
import {
  LLM_TIMEOUT_MS,
  LLM_MAX_RETRIES,
  DEFAULT_MAX_COST_USD,
  MODEL_PRICING,
  AnthropicJournalProvider,
  OpenAiJournalProvider,
  ScaffoldFallbackProvider,
  CostTracker,
  CostCapExceededError,
  MalformedJsonError,
  resolveCredentialsForModel,
  selectProvider,
} from "../../../src/tools/journal-llm-client.js";

beforeEach(() => {
  anthropicCreate.mockReset();
  openaiCreate.mockReset();
  vi.unstubAllEnvs();
  // Ensure real timers are active at test start; some tests opt into fake
  // timers individually. Without this guard, a leftover fake-timer state
  // from a sibling pool can hang the dynamic import in the timeout test.
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ─── (a) resolveCredentialsForModel ───────────────────────────────────────────
describe("resolveCredentialsForModel", () => {
  it("returns ANTHROPIC_API_KEY for claude-* model when set", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-xxx");
    expect(resolveCredentialsForModel("claude-sonnet-4-6")).toBe(
      "ANTHROPIC_API_KEY",
    );
  });

  it("returns OPENAI_API_KEY for gpt-* model when set", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-oai-xxx");
    expect(resolveCredentialsForModel("gpt-4o-mini")).toBe("OPENAI_API_KEY");
  });

  it("returns null for claude model with no key set", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(resolveCredentialsForModel("claude-sonnet-4-6")).toBeNull();
  });

  it("returns null for unknown model id", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-xxx");
    vi.stubEnv("OPENAI_API_KEY", "sk-oai-xxx");
    expect(resolveCredentialsForModel("mistral-large")).toBeNull();
  });
});

// ─── (b) Anthropic happy path ─────────────────────────────────────────────────
describe("AnthropicJournalProvider happy path", () => {
  it("returns structured LlmResult with tokens and cost", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-xxx");
    anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: '{"foo":"bar"}' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const p = new AnthropicJournalProvider();
    const r = await p.generate("hello", { model: "claude-sonnet-4-6" });
    expect(r.content).toBe('{"foo":"bar"}');
    expect(r.tokensInput).toBe(100);
    expect(r.tokensOutput).toBe(50);
    expect(r.provider).toBe("anthropic");
    // MODEL_PRICING claude-sonnet-4-6: 3/15 per million → 100*3e-6 + 50*15e-6
    expect(r.costUsd).toBeCloseTo(0.00105, 6);
  });
});

// ─── (c) 30s timeout ──────────────────────────────────────────────────────────
describe("AnthropicJournalProvider timeout", () => {
  it("rejects with timeout error after LLM_TIMEOUT_MS", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-xxx");
    // Hanging call — never resolves.
    anthropicCreate.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const p = new AnthropicJournalProvider();
    const promise = p.generate("hello", { model: "claude-sonnet-4-6" });
    // Attach a catch early so unhandled-rejection never fires.
    const caught = promise.catch((e) => e);
    // Advance in slices so microtasks (dynamic import resolution, then the
    // anthropic mock's hanging promise) flush between ticks. Advancing
    // in one big jump under fake timers can leave the import unresolved.
    for (let i = 0; i < ((LLM_TIMEOUT_MS + 1000) / 100); i++) {
      await vi.advanceTimersByTimeAsync(100);
    }
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out/);
  }, 10_000);
});

// ─── (d) 503 retry with backoff ──────────────────────────────────────────────
describe("AnthropicJournalProvider retry on 503", () => {
  it("retries up to LLM_MAX_RETRIES times then succeeds", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-xxx");
    const err503 = Object.assign(new Error("Service Unavailable"), {
      status: 503,
    });
    anthropicCreate
      .mockRejectedValueOnce(err503)
      .mockRejectedValueOnce(err503)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    const p = new AnthropicJournalProvider();
    const r = await p.generate("hi", { model: "claude-sonnet-4-6" });
    expect(r.content).toBe("ok");
    expect(anthropicCreate).toHaveBeenCalledTimes(LLM_MAX_RETRIES + 1);
  }, 10_000);
});

// ─── (e) 429 immediate — no retry ────────────────────────────────────────────
describe("AnthropicJournalProvider 429 handling", () => {
  it("does NOT retry on 429 — throws immediately", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-xxx");
    const err429 = Object.assign(new Error("rate limited"), { status: 429 });
    anthropicCreate.mockRejectedValue(err429);
    const p = new AnthropicJournalProvider();
    await expect(
      p.generate("hi", { model: "claude-sonnet-4-6" }),
    ).rejects.toMatchObject({ status: 429 });
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
  });
});

// ─── (f) cost accounting ─────────────────────────────────────────────────────
describe("cost accounting", () => {
  it("computes cost from literal pricing (100 in / 50 out @ 3/15 = 0.00105)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-xxx");
    anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const p = new AnthropicJournalProvider();
    const r = await p.generate("q", { model: "claude-sonnet-4-6" });
    // Literal math, no reference to MODEL_PRICING table in assertion.
    expect(r.costUsd).toBeCloseTo(0.00105, 6);
  });

  it("MODEL_PRICING contains sonnet pricing used above", () => {
    // Sanity: if this fails, the fixture above is stale.
    expect(MODEL_PRICING["claude-sonnet-4-6"]).toEqual({
      input: 3.0,
      output: 15.0,
    });
  });
});

// ─── (g) selectProvider → scaffold when no key ───────────────────────────────
describe("selectProvider fallback", () => {
  it("returns ScaffoldFallbackProvider when CODESIFT_JOURNAL_MODEL is claude-haiku-4-5 and no key", () => {
    vi.stubEnv("CODESIFT_JOURNAL_MODEL", "claude-haiku-4-5");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const provider = selectProvider();
    expect(provider).toBeInstanceOf(ScaffoldFallbackProvider);
  });

  it("scaffold generate returns provider:'scaffold'", async () => {
    const s = new ScaffoldFallbackProvider();
    const r = await s.generate("x", { model: "any" });
    expect(r.provider).toBe("scaffold");
    expect(r.costUsd).toBe(0);
    // Content is JSON-parseable.
    expect(() => JSON.parse(r.content)).not.toThrow();
  });
});

// ─── (h) cost cap ────────────────────────────────────────────────────────────
describe("CostTracker cost cap", () => {
  it("throws CostCapExceededError when next call would exceed cap", () => {
    const t = new CostTracker(1.0);
    t.recordActual(0.6);
    // Next estimated call of 0.5 would put us at 1.1 > 1.0.
    expect(() => t.assertCanAfford(0.5)).toThrow(CostCapExceededError);
    try {
      t.assertCanAfford(0.5);
    } catch (e) {
      expect(e).toBeInstanceOf(CostCapExceededError);
      const err = e as CostCapExceededError;
      expect(err.runningCost).toBeCloseTo(0.6, 6);
      expect(err.cap).toBe(1.0);
    }
  });

  it("does not throw when under cap", () => {
    const t = new CostTracker(1.0);
    t.recordActual(0.3);
    expect(() => t.assertCanAfford(0.4)).not.toThrow();
  });

  it("DEFAULT_MAX_COST_USD is 2.00", () => {
    expect(DEFAULT_MAX_COST_USD).toBe(2.0);
  });
});

// ─── (i) malformed JSON → one retry → throws MalformedJsonError ───────────────
describe("AnthropicJournalProvider malformed JSON", () => {
  it("retries once on non-JSON when parseJson=true, then throws", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-xxx");
    anthropicCreate
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "not-json" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "still-not-json" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    const p = new AnthropicJournalProvider();
    await expect(
      p.generate("q", { model: "claude-sonnet-4-6", parseJson: true }),
    ).rejects.toBeInstanceOf(MalformedJsonError);
    // 1 original + 1 retry = 2 calls total.
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
  });

  it("succeeds when retry returns valid JSON", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-xxx");
    anthropicCreate
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "not-json" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"ok":true}' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    const p = new AnthropicJournalProvider();
    const r = await p.generate("q", {
      model: "claude-sonnet-4-6",
      parseJson: true,
    });
    expect(r.content).toBe('{"ok":true}');
  });
});

// ─── OpenAI provider smoke ────────────────────────────────────────────────────
describe("OpenAiJournalProvider happy path", () => {
  it("returns structured result from openai SDK", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-oai-xxx");
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: "hello" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const p = new OpenAiJournalProvider();
    const r = await p.generate("q", { model: "gpt-4o-mini" });
    expect(r.content).toBe("hello");
    expect(r.provider).toBe("openai");
    // gpt-4o-mini: 0.15 / 0.60 per million → 100*0.15e-6 + 50*0.60e-6 = 0.0000450
    expect(r.costUsd).toBeCloseTo(0.000045, 8);
  });
});

// ─── constants ────────────────────────────────────────────────────────────────
describe("constants", () => {
  it("LLM_TIMEOUT_MS = 30000", () => {
    expect(LLM_TIMEOUT_MS).toBe(30_000);
  });
  it("LLM_MAX_RETRIES = 2", () => {
    expect(LLM_MAX_RETRIES).toBe(2);
  });
});
