import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  normalizePathParams,
  adaptHonoContract,
  adaptNestInventory,
  adaptNextjsContract,
  extractOutboundCalls,
  matchContracts,
} from "../../src/tools/cross-repo-contract-tools.js";
import type { ApiContractResult as HonoContractResult } from "../../src/tools/hono-api-contract.js";
import type { NestRouteInventoryResult } from "../../src/tools/nest-tools.js";
import type { ApiContractResult as NextjsContractResult } from "../../src/tools/nextjs-api-contract-tools.js";

// ---------------------------------------------------------------------------
// normalizePathParams
// ---------------------------------------------------------------------------
describe("normalizePathParams", () => {
  it("normalizes :name params", () => {
    expect(normalizePathParams("/users/:id")).toBe("/users/{param}");
  });

  it("normalizes {name} params", () => {
    expect(normalizePathParams("/users/{id}")).toBe("/users/{param}");
  });

  it("normalizes [name] params", () => {
    expect(normalizePathParams("/users/[id]")).toBe("/users/{param}");
  });

  it("normalizes [...slug] catch-all params", () => {
    expect(normalizePathParams("/files/[...slug]")).toBe("/files/{param}");
  });

  it("normalizes all three param styles in one path", () => {
    expect(normalizePathParams("/a/:x/b/{y}/c/[z]")).toBe("/a/{param}/b/{param}/c/{param}");
  });

  it("leaves paths with no params unchanged", () => {
    expect(normalizePathParams("/api/users")).toBe("/api/users");
  });

  it("strips trailing slash", () => {
    expect(normalizePathParams("/api/users/")).toBe("/api/users");
  });

  it("preserves root slash only", () => {
    expect(normalizePathParams("/")).toBe("/");
  });

  it("strips trailing slash with param", () => {
    expect(normalizePathParams("/users/:id/")).toBe("/users/{param}");
  });
});

// ---------------------------------------------------------------------------
// adaptHonoContract
// ---------------------------------------------------------------------------
describe("adaptHonoContract", () => {
  it("converts summary entries to RepoEndpoint[]", () => {
    const hono: HonoContractResult = {
      summary: [
        { path: "/users/:id", method: "get", source: "explicit", file: "src/routes/users.ts" },
        { path: "/posts", method: "POST", source: "inferred", file: "src/routes/posts.ts" },
      ],
    };
    expect(adaptHonoContract("api-repo", hono)).toEqual([
      {
        repo: "api-repo",
        method: "GET",
        path: "/users/:id",
        normalized_path: "/users/{param}",
        file: "src/routes/users.ts",
      },
      {
        repo: "api-repo",
        method: "POST",
        path: "/posts",
        normalized_path: "/posts",
        file: "src/routes/posts.ts",
      },
    ]);
  });

  it("returns [] when summary is undefined (QA Risk 5 — no throw)", () => {
    const hono: HonoContractResult = { format: "openapi" };
    expect(adaptHonoContract("api-repo", hono)).toEqual([]);
  });

  it("returns [] when summary is empty array", () => {
    const hono: HonoContractResult = { summary: [] };
    expect(adaptHonoContract("api-repo", hono)).toEqual([]);
  });

  it("uppercases method", () => {
    const hono: HonoContractResult = {
      summary: [{ path: "/x", method: "delete", source: "explicit", file: "f.ts" }],
    };
    const [ep] = adaptHonoContract("r", hono);
    expect(ep!.method).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// adaptNestInventory
// ---------------------------------------------------------------------------
describe("adaptNestInventory", () => {
  it("converts routes to RepoEndpoint[]", () => {
    const nest: NestRouteInventoryResult = {
      routes: [
        {
          method: "GET",
          path: "/users/:id",
          handler: "getUser",
          controller: "UsersController",
          file: "src/users/users.controller.ts",
          guards: [],
          params: [],
        },
        {
          method: "post",
          path: "/users",
          handler: "createUser",
          controller: "UsersController",
          file: "src/users/users.controller.ts",
          guards: [],
          params: [],
        },
      ],
      stats: { total_routes: 2, protected: 0, unprotected: 2 },
    };
    expect(adaptNestInventory("nest-repo", nest)).toEqual([
      {
        repo: "nest-repo",
        method: "GET",
        path: "/users/:id",
        normalized_path: "/users/{param}",
        file: "src/users/users.controller.ts",
      },
      {
        repo: "nest-repo",
        method: "POST",
        path: "/users",
        normalized_path: "/users",
        file: "src/users/users.controller.ts",
      },
    ]);
  });

  it("returns [] for empty routes array", () => {
    const nest: NestRouteInventoryResult = {
      routes: [],
      stats: { total_routes: 0, protected: 0, unprotected: 0 },
    };
    expect(adaptNestInventory("nest-repo", nest)).toEqual([]);
  });

  it("uppercases method", () => {
    const nest: NestRouteInventoryResult = {
      routes: [
        {
          method: "patch",
          path: "/x",
          handler: "h",
          controller: "C",
          file: "f.ts",
          guards: [],
          params: [],
        },
      ],
      stats: { total_routes: 1, protected: 0, unprotected: 1 },
    };
    const [ep] = adaptNestInventory("r", nest);
    expect(ep!.method).toBe("PATCH");
  });

  it("uses empty string for file when entry file is empty string", () => {
    const nest: NestRouteInventoryResult = {
      routes: [
        {
          method: "GET",
          path: "/x",
          handler: "h",
          controller: "C",
          file: "",
          guards: [],
          params: [],
        },
      ],
      stats: { total_routes: 1, protected: 0, unprotected: 1 },
    };
    const [ep] = adaptNestInventory("r", nest);
    expect(ep!.file).toBe("");
  });
});

// ---------------------------------------------------------------------------
// adaptNextjsContract
// ---------------------------------------------------------------------------
describe("adaptNextjsContract", () => {
  it("converts handlers to RepoEndpoint[]", () => {
    const nextjs: NextjsContractResult = {
      handlers: [
        {
          method: "GET",
          path: "/api/users",
          router: "app",
          query_params: [],
          request_schema: null,
          response_shapes: [],
          inferred_status_codes: [200],
          completeness: 0.8,
          file: "src/app/api/users/route.ts",
        },
      ],
      total: 1,
      completeness_score: 80,
      parse_failures: [],
      scan_errors: [],
      workspaces_scanned: [],
      limitations: [],
    };
    expect(adaptNextjsContract("next-repo", nextjs)).toEqual([
      {
        repo: "next-repo",
        method: "GET",
        path: "/api/users",
        normalized_path: "/api/users",
        file: "src/app/api/users/route.ts",
      },
    ]);
  });

  it("expands a handler with multiple methods into one RepoEndpoint per method", () => {
    // HandlerShape.method is a single HttpMethod per handler — but we expose the
    // expansion path for completeness by testing multiple handlers each with one method.
    // (Next.js route files expose one handler per HTTP verb.)
    const nextjs: NextjsContractResult = {
      handlers: [
        {
          method: "GET",
          path: "/api/items/[id]",
          router: "app",
          query_params: [],
          request_schema: null,
          response_shapes: [],
          inferred_status_codes: [200],
          completeness: 1,
          file: "src/app/api/items/[id]/route.ts",
        },
        {
          method: "DELETE",
          path: "/api/items/[id]",
          router: "app",
          query_params: [],
          request_schema: null,
          response_shapes: [],
          inferred_status_codes: [204],
          completeness: 1,
          file: "src/app/api/items/[id]/route.ts",
        },
      ],
      total: 2,
      completeness_score: 100,
      parse_failures: [],
      scan_errors: [],
      workspaces_scanned: [],
      limitations: [],
    };
    expect(adaptNextjsContract("next-repo", nextjs)).toEqual([
      {
        repo: "next-repo",
        method: "GET",
        path: "/api/items/[id]",
        normalized_path: "/api/items/{param}",
        file: "src/app/api/items/[id]/route.ts",
      },
      {
        repo: "next-repo",
        method: "DELETE",
        path: "/api/items/[id]",
        normalized_path: "/api/items/{param}",
        file: "src/app/api/items/[id]/route.ts",
      },
    ]);
  });

  it("returns [] when handlers is empty", () => {
    const nextjs: NextjsContractResult = {
      handlers: [],
      total: 0,
      completeness_score: 0,
      parse_failures: [],
      scan_errors: [],
      workspaces_scanned: [],
      limitations: [],
    };
    expect(adaptNextjsContract("next-repo", nextjs)).toEqual([]);
  });

  it("normalizes path params from [param] segments", () => {
    const nextjs: NextjsContractResult = {
      handlers: [
        {
          method: "POST",
          path: "/api/users/[userId]/posts/[postId]",
          router: "app",
          query_params: [],
          request_schema: null,
          response_shapes: [],
          inferred_status_codes: [201],
          completeness: 0.5,
          file: "f.ts",
        },
      ],
      total: 1,
      completeness_score: 50,
      parse_failures: [],
      scan_errors: [],
      workspaces_scanned: [],
      limitations: [],
    };
    const [ep] = adaptNextjsContract("r", nextjs);
    expect(ep!.normalized_path).toBe("/api/users/{param}/posts/{param}");
  });
});

// ---------------------------------------------------------------------------
// extractOutboundCalls
// ---------------------------------------------------------------------------

describe("extractOutboundCalls — fetch", () => {
  it("detects a plain string GET fetch (no second arg)", () => {
    const src = `fetch("/api/users/1")`;
    const calls = extractOutboundCalls(src, "client.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url_prefix: "/api/users/1",
      method: "GET",
      partial: false,
      file: "client.ts",
    });
  });

  it("detects fetch line number (1-based)", () => {
    const src = `const x = 1;\nfetch("/api/users/1")`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]!.line).toBe(2);
  });

  it("detects POST from second-arg options literal", () => {
    const src = `fetch("/api/orders", { method: "POST", body: JSON.stringify(data) })`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/api/orders", method: "POST", partial: false });
  });

  it("detects PUT method from second-arg", () => {
    const src = `fetch("/api/orders/1", { method: 'PUT' })`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ method: "PUT" });
  });

  it("detects DELETE method from second-arg", () => {
    const src = `fetch("/api/items/5", { method: 'DELETE' })`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ method: "DELETE" });
  });

  it("defaults to GET when method is absent in options", () => {
    const src = `fetch("/api/health", { headers: {} })`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ method: "GET" });
  });

  it("strips origin from full URL", () => {
    const src = `fetch("https://api.example.com/v1/users")`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ url_prefix: "/v1/users", partial: false });
  });

  it("returns [] for unrelated source", () => {
    const src = `const x = 1;\nconsole.log("hello");`;
    expect(extractOutboundCalls(src, "f.ts")).toEqual([]);
  });
});

describe("extractOutboundCalls — template literals", () => {
  it("extracts static prefix after leading variable interpolation", () => {
    const src = "fetch(`${BASE}/users/${id}`)";
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/users/", partial: true });
  });

  it("extracts prefix up to mid-string interpolation", () => {
    const src = "fetch(`/users/${id}/posts`)";
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ url_prefix: "/users/", partial: true });
  });

  it("template literal with no interpolation is non-partial", () => {
    const src = "fetch(`/api/status`)";
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ url_prefix: "/api/status", partial: false });
  });
});

describe("extractOutboundCalls — string concat", () => {
  it("extracts prefix from '/path/' + var concatenation", () => {
    const src = `fetch('/users/' + id)`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/users/", partial: true });
  });
});

describe("extractOutboundCalls — axios", () => {
  it("detects axios.get", () => {
    const src = `axios.get('/orders')`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/orders", method: "GET", partial: false });
  });

  it("detects axios.post", () => {
    const src = `axios.post('/orders', data)`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ url_prefix: "/orders", method: "POST" });
  });

  it("detects axios.put", () => {
    const src = `axios.put('/orders/1', data)`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ method: "PUT" });
  });

  it("detects axios.patch", () => {
    const src = `axios.patch('/orders/1', data)`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ method: "PATCH" });
  });

  it("detects axios.delete", () => {
    const src = `axios.delete('/orders/1')`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ method: "DELETE" });
  });
});

describe("extractOutboundCalls — got", () => {
  it("detects got.get", () => {
    const src = `got.get("/x")`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/x", method: "GET" });
  });

  it("detects got.post", () => {
    const src = `got.post("/x")`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ method: "POST" });
  });

  it("detects got.put", () => {
    const src = `got.put("/x")`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ method: "PUT" });
  });

  it("detects got.patch", () => {
    const src = `got.patch("/x")`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ method: "PATCH" });
  });

  it("detects got.delete", () => {
    const src = `got.delete("/x")`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ method: "DELETE" });
  });
});

describe("extractOutboundCalls — comment stripping", () => {
  it("ignores fetch inside a line comment", () => {
    const src = `// fetch("/api/users")\nconst x = 1;`;
    expect(extractOutboundCalls(src, "f.ts")).toEqual([]);
  });

  it("ignores fetch inside a block comment", () => {
    const src = `/* fetch("/api/users") */\nconst x = 1;`;
    expect(extractOutboundCalls(src, "f.ts")).toEqual([]);
  });

  it("still detects fetch after a commented-out fetch", () => {
    const src = `// fetch("/old")\nfetch("/api/new")`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/api/new" });
  });
});

// ---------------------------------------------------------------------------
// matchContracts — Task 14
// ---------------------------------------------------------------------------

import type { RepoEndpoint, ContractMatch } from "../../src/types.js";
import type { OutboundCall } from "../../src/tools/cross-repo-contract-tools.js";

type ConsumerCall = OutboundCall & { repo: string };

/** Helper — build a producer RepoEndpoint */
function producer(repo: string, method: string, path: string, file = "src/routes.ts"): RepoEndpoint {
  const { normalizePathParams: norm } = { normalizePathParams };
  return { repo, method: method.toUpperCase(), path, normalized_path: norm(path), file };
}

/** Helper — build a consumer OutboundCall + repo */
function consumer(
  repo: string,
  method: string,
  url_prefix: string,
  partial: boolean,
  file = "src/client.ts",
  line = 1,
): ConsumerCall {
  return { repo, method: method.toUpperCase(), url_prefix, partial, file, line };
}

describe("matchContracts", () => {
  // ── T14-1: exact template instantiation ───────────────────────────────────
  it("T14-1: exact — concrete path instantiates producer template", () => {
    const producers: RepoEndpoint[] = [producer("api", "GET", "/users/:id")];
    const consumers: ConsumerCall[] = [
      consumer("web", "GET", "/users/1", false),
    ];
    const matches = matchContracts(producers, consumers);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      producer_repo: "api",
      consumer_repo: "web",
      method: "GET",
      path: "/users/{param}",
      consumer_file: "src/client.ts",
      consumer_line: 1,
      confidence: "exact",
    });
  });

  // ── T14-2: exact literal-to-literal ──────────────────────────────────────
  it("T14-2: exact — literal path to literal endpoint", () => {
    const producers: RepoEndpoint[] = [producer("api", "GET", "/health")];
    const consumers: ConsumerCall[] = [consumer("web", "GET", "/health", false)];
    const matches = matchContracts(producers, consumers);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.confidence).toBe("exact");
    expect(matches[0]!.path).toBe("/health");
  });

  // ── T14-3: partial prefix match ───────────────────────────────────────────
  it("T14-3: partial — consumer prefix matches template literal head", () => {
    const producers: RepoEndpoint[] = [producer("api", "GET", "/users/:id")];
    const consumers: ConsumerCall[] = [
      consumer("web", "GET", "/users/", true),
    ];
    const matches = matchContracts(producers, consumers);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.confidence).toBe("partial");
  });

  // ── T14-4: method mismatch → no match ────────────────────────────────────
  it("T14-4: no match on method mismatch", () => {
    const producers: RepoEndpoint[] = [producer("api", "POST", "/users/:id")];
    const consumers: ConsumerCall[] = [consumer("web", "GET", "/users/1", false)];
    expect(matchContracts(producers, consumers)).toHaveLength(0);
  });

  // ── T14-5: same-repo excluded ─────────────────────────────────────────────
  it("T14-5: same-repo producer/consumer excluded", () => {
    const producers: RepoEndpoint[] = [producer("api", "GET", "/users/:id")];
    const consumers: ConsumerCall[] = [consumer("api", "GET", "/users/1", false)];
    expect(matchContracts(producers, consumers)).toHaveLength(0);
  });

  // ── T14-6a: multiple consumers of one endpoint → all reported ────────────
  it("T14-6a: multiple consumers of same endpoint all reported", () => {
    const producers: RepoEndpoint[] = [producer("api", "GET", "/users/:id")];
    const consumers: ConsumerCall[] = [
      consumer("web", "GET", "/users/1", false, "src/pageA.ts", 10),
      consumer("mobile", "GET", "/users/42", false, "src/screen.ts", 5),
    ];
    const matches = matchContracts(producers, consumers);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.consumer_repo).sort()).toEqual(["mobile", "web"]);
  });

  // ── T14-6b: one consumer matching multiple producers → all reported ───────
  it("T14-6b: one consumer matching multiple producers (ambiguous prefix) — all reported", () => {
    const producers: RepoEndpoint[] = [
      producer("api-a", "GET", "/users/:id"),
      producer("api-b", "GET", "/users/:id"),
    ];
    const consumers: ConsumerCall[] = [consumer("web", "GET", "/users/", true)];
    const matches = matchContracts(producers, consumers);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.producer_repo).sort()).toEqual(["api-a", "api-b"]);
  });

  // ── T14-7: deduplication ──────────────────────────────────────────────────
  it("T14-7: identical (producer_repo, consumer_file, line, path, method) deduplicated", () => {
    // Same producer and consumer but listed twice in consumers
    const producers: RepoEndpoint[] = [producer("api", "GET", "/users/:id")];
    const dup: ConsumerCall = consumer("web", "GET", "/users/1", false, "src/client.ts", 5);
    const matches = matchContracts(producers, [dup, dup]);
    expect(matches).toHaveLength(1);
  });

  // ── T14-8: empty inputs ───────────────────────────────────────────────────
  it("T14-8: empty producers → []", () => {
    expect(matchContracts([], [consumer("web", "GET", "/users/1", false)])).toEqual([]);
  });

  it("T14-8: empty consumers → []", () => {
    expect(matchContracts([producer("api", "GET", "/users/:id")], [])).toEqual([]);
  });

  it("T14-8: both empty → []", () => {
    expect(matchContracts([], [])).toEqual([]);
  });

  // ── T14-9: "who calls GET /users/{param}" query shape ────────────────────
  it("T14-9: result is filterable by path+method to answer 'who calls GET /users/{param}'", () => {
    const producers: RepoEndpoint[] = [
      producer("api", "GET", "/users/:id"),
      producer("api", "POST", "/orders"),
    ];
    const consumers: ConsumerCall[] = [
      consumer("web", "GET", "/users/7", false, "src/UserPage.ts", 20),
      consumer("web", "POST", "/orders", false, "src/OrderForm.ts", 15),
    ];
    const allMatches = matchContracts(producers, consumers);
    const callers = allMatches.filter(
      (m) => m.path === "/users/{param}" && m.method === "GET",
    );
    expect(callers).toHaveLength(1);
    expect(callers[0]!.consumer_file).toBe("src/UserPage.ts");
  });

  // ── Extra edge cases ──────────────────────────────────────────────────────
  it("no match when consumer path does not instantiate template", () => {
    // "/users/1/2" has 3 segments vs "/users/{param}" has 2 — should NOT match
    const producers: RepoEndpoint[] = [producer("api", "GET", "/users/:id")];
    const consumers: ConsumerCall[] = [consumer("web", "GET", "/users/1/2", false)];
    expect(matchContracts(producers, consumers)).toHaveLength(0);
  });

  it("multi-segment template match — both params instantiated", () => {
    const producers: RepoEndpoint[] = [producer("api", "GET", "/users/:userId/posts/:postId")];
    const consumers: ConsumerCall[] = [consumer("web", "GET", "/users/5/posts/10", false)];
    const matches = matchContracts(producers, consumers);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.confidence).toBe("exact");
  });

  it("partial prefix — leading literal segments with trailing slash", () => {
    // prefix "/users/" should match "/users/{param}/settings" as partial
    const producers: RepoEndpoint[] = [producer("api", "GET", "/users/:id/settings")];
    const consumers: ConsumerCall[] = [consumer("web", "GET", "/users/", true)];
    const matches = matchContracts(producers, consumers);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.confidence).toBe("partial");
  });

  it("partial consumer with empty url_prefix does not match anything", () => {
    const producers: RepoEndpoint[] = [producer("api", "GET", "/users/:id")];
    const consumers: ConsumerCall[] = [consumer("web", "GET", "", true)];
    expect(matchContracts(producers, consumers)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SIX CRITICALS — C1–C6
// ---------------------------------------------------------------------------

describe("extractOutboundCalls — C1: query/hash stripping", () => {
  it("C1a: strips query string from fetch URL", () => {
    const src = `fetch("/api/users?page=1")`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/api/users", partial: false });
  });

  it("C1b: strips fragment from fetch URL", () => {
    const src = `fetch("/x#frag")`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/x", partial: false });
  });

  it("C1c: strips query from axios.get URL", () => {
    const src = `axios.get("/api/items?sort=asc")`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls[0]).toMatchObject({ url_prefix: "/api/items", method: "GET" });
  });
});

describe("extractOutboundCalls — C2: inner-brace interpolation", () => {
  it("C2: template with object literal in interpolation does not crash or truncate", () => {
    const src = "fetch(`/api/${ {a:1}.a }/users`)";
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/api/", partial: true });
  });
});

describe("extractOutboundCalls — C3: regex literal not treated as comment", () => {
  it("C3: regex literal with escaped slash does not destroy following fetch call", () => {
    const src = `const re=/a\\/b/g;\nfetch("/keep")`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/keep" });
  });
});

describe("extractOutboundCalls — C4: multi-line fetch/template", () => {
  it("C4a: fetch with newline before quote string is extracted", () => {
    const src = `fetch(\n  "/api/x"\n)`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/api/x" });
  });

  it("C4b: fetch with multi-line template literal is extracted", () => {
    const src = "fetch(`\n  /api/x\n`)";
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/api/x", partial: false });
  });
});

describe("extractOutboundCalls — C5: wide-spaced string concat", () => {
  it("C5: fetch('/users/'   +   id) marks partial with wide spacing", () => {
    const src = `fetch('/users/'   +   id)`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/users/", partial: true });
  });
});

describe("extractOutboundCalls — C6: no false positives from string literals", () => {
  it("C6a: fetch call inside a string literal is NOT reported", () => {
    const src = `const s = "fetch('/nope')"`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(0);
  });

  it("C6b: real fetch after string-embedded fetch is reported once", () => {
    const src = `const s = "fetch('/nope')";\nfetch('/yes')`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url_prefix: "/yes" });
  });

  it("C6c: axios call inside a string literal is NOT reported", () => {
    const src = `const doc = "use axios.get('/nope') to call"`;
    const calls = extractOutboundCalls(src, "f.ts");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// REAL-CORPUS RECALL GATE
// ---------------------------------------------------------------------------

describe("extractOutboundCalls — real corpus recall ≥ 0.8", () => {
  const corpusDir = join(__dirname, "../fixtures/outbound-corpus");

  interface ExpectedCall {
    file: string;
    url_prefix: string;
    method: string;
    partial: boolean;
  }

  const expected: ExpectedCall[] = JSON.parse(
    readFileSync(join(corpusDir, "expected.json"), "utf-8"),
  ) as ExpectedCall[];

  it("detects expected calls from real source files with ≥80% recall", () => {
    // Collect all detected calls from the corpus files
    const detected: Array<{ file: string; url_prefix: string; method: string }> = [];

    for (const exp of expected) {
      const src = readFileSync(join(corpusDir, exp.file), "utf-8");
      const calls = extractOutboundCalls(src, exp.file);
      for (const c of calls) {
        detected.push({ file: c.file, url_prefix: c.url_prefix, method: c.method });
      }
    }

    // Match: same file + url_prefix + method (partial is informational)
    let matched = 0;
    for (const exp of expected) {
      const hit = detected.some(
        (d) => d.file === exp.file && d.url_prefix === exp.url_prefix && d.method === exp.method,
      );
      if (hit) matched++;
    }

    const recall = matched / expected.length;
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });
});
