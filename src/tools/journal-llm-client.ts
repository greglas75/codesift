// LLM client for the wiki journal generator.
// CQ14: env credentials are read ONLY inside resolveCredentialsForModel +
//       readCredentialValue (helper invoked by selectProvider). Providers
//       receive the key via their constructor — they do not touch process.env.
// CQ8: external calls wrapped in timeout + typed errors.
// CQ12: SDKs imported dynamically via await import() to keep them optional.

export const LLM_TIMEOUT_MS = 30_000;
export const LLM_MAX_RETRIES = 2;
export const DEFAULT_MAX_COST_USD = 2.0;

export const MODEL_PRICING: Record<string, { input: number; output: number }> =
  {
    "claude-opus-4-7": { input: 15.0, output: 75.0 },
    "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
    "claude-haiku-4-5": { input: 0.8, output: 4.0 },
    "gpt-4o": { input: 2.5, output: 10.0 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
  };

export interface LlmResult {
  content: string;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  provider: "anthropic" | "openai" | "scaffold";
}

export interface GenerateOptions {
  model: string;
  systemPrompt?: string;
  maxTokens?: number;
  /** When true, non-JSON content triggers one retry then MalformedJsonError. */
  parseJson?: boolean;
}

export interface JournalLlmProvider {
  generate(prompt: string, options: GenerateOptions): Promise<LlmResult>;
}

export class CostCapExceededError extends Error {
  readonly runningCost: number;
  readonly cap: number;
  constructor(runningCost: number, cap: number) {
    super(`Cost cap exceeded: running=$${runningCost.toFixed(4)} cap=$${cap.toFixed(2)}`);
    this.name = "CostCapExceededError";
    this.runningCost = runningCost;
    this.cap = cap;
  }
}

export class MalformedJsonError extends Error {
  constructor(m = "LLM returned non-JSON content after retry") { super(m); this.name = "MalformedJsonError"; }
}

export class CostTracker {
  private running = 0;
  constructor(private readonly cap: number = DEFAULT_MAX_COST_USD) {}
  assertCanAfford(estimatedCost: number): void {
    if (this.running + estimatedCost > this.cap) throw new CostCapExceededError(this.running, this.cap);
  }
  recordActual(cost: number): void { this.running += cost; }
  getTotal(): number { return this.running; }
}

/** CQ14: ONLY site that reads provider env keys (returns env-var NAME). */
export function resolveCredentialsForModel(modelId: string): string | null {
  if (modelId.startsWith("claude-")) return process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : null;
  if (modelId.startsWith("gpt-")) return process.env.OPENAI_API_KEY ? "OPENAI_API_KEY" : null;
  return null;
}

/** Internal helper — reads the actual value for a credential name resolved above. */
function readCredentialValue(name: string): string | undefined {
  return process.env[name];
}

function computeCost(model: string, tIn: number, tOut: number): number {
  const p = MODEL_PRICING[model];
  if (!p) throw new Error(`No pricing for model "${model}"; refusing to estimate cost (cap-safety)`);
  return tIn * 1e-6 * p.input + tOut * 1e-6 * p.output;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const h = setTimeout(() => reject(new Error(`LLM request timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(h); resolve(v); }, (e) => { clearTimeout(h); reject(e); });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isRetryable = (s: number | undefined) => s === 500 || s === 503 || s === 504;

async function callWithRetry<T>(op: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try { return await withTimeout(op(), LLM_TIMEOUT_MS); }
    catch (err: unknown) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      if (!isRetryable(status) || attempt === LLM_MAX_RETRIES) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

const isJsonParseable = (t: string) => { try { JSON.parse(t); return true; } catch { return false; } };

async function withJsonRetry(
  opts: GenerateOptions,
  doOnce: () => Promise<LlmResult>,
): Promise<LlmResult> {
  const first = await doOnce();
  if (!opts.parseJson || isJsonParseable(first.content)) return first;
  const second = await doOnce();
  if (!isJsonParseable(second.content)) throw new MalformedJsonError();
  return second;
}

export class AnthropicJournalProvider implements JournalLlmProvider {
  constructor(private readonly apiKey?: string) {}
  async generate(prompt: string, opts: GenerateOptions): Promise<LlmResult> {
    const mod = (await import("@anthropic-ai/sdk")) as {
      default: new (cfg: { apiKey?: string | undefined }) => {
        messages: { create: (req: unknown) => Promise<{
          content: Array<{ type: string; text: string }>;
          usage: { input_tokens: number; output_tokens: number };
        }> };
      };
    };
    const client = new mod.default({ apiKey: this.apiKey });
    const body: Record<string, unknown> = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      messages: [{ role: "user", content: prompt }],
    };
    if (opts.systemPrompt) body["system"] = opts.systemPrompt;
    const doOnce = async (): Promise<LlmResult> => {
      const resp = await callWithRetry(() => client.messages.create(body));
      const tIn = resp.usage.input_tokens, tOut = resp.usage.output_tokens;
      return {
        content: resp.content[0]?.text ?? "",
        tokensInput: tIn, tokensOutput: tOut,
        costUsd: computeCost(opts.model, tIn, tOut),
        provider: "anthropic",
      };
    };
    return withJsonRetry(opts, doOnce);
  }
}

export class OpenAiJournalProvider implements JournalLlmProvider {
  constructor(private readonly apiKey?: string) {}
  async generate(prompt: string, opts: GenerateOptions): Promise<LlmResult> {
    const mod = (await import("openai")) as {
      default: new (cfg: { apiKey?: string | undefined }) => {
        chat: { completions: { create: (req: unknown) => Promise<{
          choices: Array<{ message: { content: string | null } }>;
          usage: { prompt_tokens: number; completion_tokens: number };
        }> } };
      };
    };
    const client = new mod.default({ apiKey: this.apiKey });
    const msgs: Array<{ role: string; content: string }> = [];
    if (opts.systemPrompt) msgs.push({ role: "system", content: opts.systemPrompt });
    msgs.push({ role: "user", content: prompt });
    const body = { model: opts.model, messages: msgs, max_tokens: opts.maxTokens ?? 4096 };
    const doOnce = async (): Promise<LlmResult> => {
      const resp = await callWithRetry(() => client.chat.completions.create(body));
      const tIn = resp.usage.prompt_tokens, tOut = resp.usage.completion_tokens;
      return {
        content: resp.choices[0]?.message?.content ?? "",
        tokensInput: tIn, tokensOutput: tOut,
        costUsd: computeCost(opts.model, tIn, tOut),
        provider: "openai",
      };
    };
    return withJsonRetry(opts, doOnce);
  }
}

export class ScaffoldFallbackProvider implements JournalLlmProvider {
  async generate(_prompt: string, _opts: GenerateOptions): Promise<LlmResult> {
    return {
      content: JSON.stringify({ summary: "TODO: fill in summary", highlights: [], risks: [] }),
      tokensInput: 0, tokensOutput: 0, costUsd: 0, provider: "scaffold",
    };
  }
}

export function selectProvider(): JournalLlmProvider {
  const model = process.env["CODESIFT_JOURNAL_MODEL"] ?? "claude-sonnet-4-6";
  const cred = resolveCredentialsForModel(model);
  if (!cred) return new ScaffoldFallbackProvider();
  const value = readCredentialValue(cred);
  if (cred === "ANTHROPIC_API_KEY") return new AnthropicJournalProvider(value);
  if (cred === "OPENAI_API_KEY") return new OpenAiJournalProvider(value);
  return new ScaffoldFallbackProvider();
}
