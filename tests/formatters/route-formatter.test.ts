import { describe, it, expect } from "vitest";
import { formatTraceRoute } from "../../src/formatters.js";

describe("formatTraceRoute with Next.js extensions", () => {
  it("renders middleware, layout chain, and server actions", () => {
    const result = {
      path: "/api/users",
      handlers: [
        { file: "app/api/users/route.ts", symbol: { name: "GET", kind: "function", file: "app/api/users/route.ts", start_line: 1 } },
      ],
      call_chain: [],
      db_calls: [],
      middleware: { file: "middleware.ts", matchers: ["/api/:path*"], applies: true },
      layout_chain: ["app/layout.tsx", "app/products/layout.tsx"],
      server_actions: [{ name: "updateUser", file: "app/actions/updateUser.ts" }],
    };

    const output = formatTraceRoute(result);
    expect(output).toMatch(/Middleware:/);
    expect(output).toMatch(/middleware\.ts/);
    expect(output).toMatch(/applies/i);
    expect(output).toMatch(/Layout chain:/);
    expect(output).toMatch(/app\/layout\.tsx/);
    expect(output).toMatch(/app\/products\/layout\.tsx/);
    expect(output).toMatch(/Server Actions:/);
    expect(output).toMatch(/updateUser/);
  });
});
