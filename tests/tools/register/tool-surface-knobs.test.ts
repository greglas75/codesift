import { afterEach, describe, expect, it } from "vitest";
import { CORE_TOOL_NAMES, resolveVisibleToolNames } from "../../../src/register-tools/discovery.js";
import { CODESIFT_INSTRUCTIONS, CODESIFT_INSTRUCTIONS_BRIEF, resolveInstructions } from "../../../src/instructions.js";

const VISIBLE = "CODESIFT_VISIBLE_TOOLS";
const BRIEF = "CODESIFT_BRIEF_INSTRUCTIONS";

afterEach(() => {
  delete process.env[VISIBLE];
  delete process.env[BRIEF];
});

describe("resolveVisibleToolNames", () => {
  it("defaults to the unchanged core surface", () => {
    expect(resolveVisibleToolNames()).toBe(CORE_TOOL_NAMES);
  });

  it("restricts the surface to an explicit list", () => {
    process.env[VISIBLE] = "search_text,search_symbols";
    const names = resolveVisibleToolNames();
    expect([...names].sort()).toEqual(["search_symbols", "search_text"]);
  });

  it("tolerates whitespace and empty entries in the list", () => {
    process.env[VISIBLE] = " search_text , , search_symbols ,";
    expect([...resolveVisibleToolNames()].sort()).toEqual(["search_symbols", "search_text"]);
  });

  // A var set to something that parses to nothing is a typo. Honouring it literally would register
  // zero tools and present as "codesift is broken" rather than as a bad value.
  it("falls back to core when the list parses to nothing", () => {
    for (const bad of ["", "   ", ",,,"]) {
      process.env[VISIBLE] = bad;
      expect(resolveVisibleToolNames()).toBe(CORE_TOOL_NAMES);
    }
  });
});

describe("resolveInstructions", () => {
  it("defaults to the full instructions", () => {
    expect(resolveInstructions()).toBe(CODESIFT_INSTRUCTIONS);
  });

  it("returns the brief field only for an exact opt-in", () => {
    process.env[BRIEF] = "1";
    expect(resolveInstructions()).toBe(CODESIFT_INSTRUCTIONS_BRIEF);
    for (const notOptIn of ["0", "true", "yes", ""]) {
      process.env[BRIEF] = notOptIn;
      expect(resolveInstructions()).toBe(CODESIFT_INSTRUCTIONS);
    }
  });

  // The point of the brief field is the token count — a "brief" variant that drifted back up to the
  // size of the full one would pass every other assertion here while buying nothing.
  it("is materially smaller than the full instructions", () => {
    expect(CODESIFT_INSTRUCTIONS_BRIEF.length).toBeLessThan(CODESIFT_INSTRUCTIONS.length / 4);
  });

  // Whatever else is trimmed, the brief field must still say what to use instead of grep and that
  // the repo resolves itself — those two are what change behaviour.
  it("keeps the load-bearing guidance", () => {
    for (const must of ["search_text", "search_symbols", "plan_turn", "Grep"]) {
      expect(CODESIFT_INSTRUCTIONS_BRIEF).toContain(must);
    }
  });
});
