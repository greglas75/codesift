import { afterEach, describe, expect, it } from "vitest";
import { CORE_TOOL_NAMES, SINGLE_TOOL_SURFACE, resolveVisibleToolNames } from "../../../src/register-tools/discovery.js";
import { TOOL_DEFINITION_MAP } from "../../../src/register-tools/discovery.js";
import {
  CODESIFT_INSTRUCTIONS,
  CODESIFT_INSTRUCTIONS_BRIEF,
  CODESIFT_INSTRUCTIONS_SERVER,
  CODESIFT_INSTRUCTIONS_SINGLE,
  HOST_INSTRUCTIONS_CHAR_CAP,
  resolveInstructions,
} from "../../../src/instructions.js";

const VISIBLE = "CODESIFT_VISIBLE_TOOLS";
const BRIEF = "CODESIFT_BRIEF_INSTRUCTIONS";
const FULL = "CODESIFT_FULL_INSTRUCTIONS";
const SURFACE = "CODESIFT_TOOL_SURFACE";

afterEach(() => {
  delete process.env[VISIBLE];
  delete process.env[BRIEF];
  delete process.env[FULL];
  delete process.env[SURFACE];
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
  // The full manual is ~6.5K chars and Claude Code cuts server instructions at 2,048, so the
  // default is the capped field; the full one is served by the initial_instructions tool.
  it("defaults to the host-capped instructions", () => {
    expect(resolveInstructions()).toBe(CODESIFT_INSTRUCTIONS_SERVER);
  });

  it("returns the brief field only for an exact opt-in", () => {
    process.env[BRIEF] = "1";
    expect(resolveInstructions()).toBe(CODESIFT_INSTRUCTIONS_BRIEF);
    for (const notOptIn of ["0", "true", "yes", ""]) {
      process.env[BRIEF] = notOptIn;
      expect(resolveInstructions()).toBe(CODESIFT_INSTRUCTIONS_SERVER);
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

describe("default instructions field fits the host cap", () => {
  // Claude Code truncates server instructions at 2,048 chars. A default over the cap is silently cut
  // wherever the host decides — in practice after the catalog preamble, before ALWAYS/NEVER.
  it("stays under the Claude Code cap", () => {
    expect(CODESIFT_INSTRUCTIONS_SERVER.length).toBeLessThan(HOST_INSTRUCTIONS_CHAR_CAP);
  });

  it("is what an unconfigured server sends", () => {
    expect(resolveInstructions()).toBe(CODESIFT_INSTRUCTIONS_SERVER);
  });

  it("returns the full manual only on an exact opt-in", () => {
    process.env[FULL] = "1";
    expect(resolveInstructions()).toBe(CODESIFT_INSTRUCTIONS);
    process.env[FULL] = "true";
    expect(resolveInstructions()).toBe(CODESIFT_INSTRUCTIONS_SERVER);
  });

  it("keeps the rules whose absence sends agents back to grep", () => {
    for (const must of ["Grep", "list_repos", "STALE INDEX", "index_folder", "WORKTREE", "plan_turn", "initial_instructions", "H19"]) {
      expect(CODESIFT_INSTRUCTIONS_SERVER).toContain(must);
    }
  });
});

describe("CODESIFT_TOOL_SURFACE=single", () => {
  it("selects the single-tool surface", () => {
    process.env[SURFACE] = "single";
    expect(resolveVisibleToolNames()).toBe(SINGLE_TOOL_SURFACE);
  });

  it("yields to an explicit CODESIFT_VISIBLE_TOOLS", () => {
    process.env[SURFACE] = "single";
    process.env[VISIBLE] = "search_symbols";
    expect([...resolveVisibleToolNames()]).toEqual(["search_symbols"]);
  });

  it("leaves the default surface alone for any other value", () => {
    process.env[SURFACE] = "SINGLE";
    expect(resolveVisibleToolNames()).toBe(CORE_TOOL_NAMES);
  });

  // A surface naming a tool that does not exist registers nothing for it — the arm would silently
  // measure a smaller surface than intended.
  it("names only real tools", () => {
    for (const name of SINGLE_TOOL_SURFACE) expect(TOOL_DEFINITION_MAP.has(name)).toBe(true);
  });

  // The default field names a dozen tools this surface never registers.
  it("sends instructions that name only the tools the surface has", () => {
    process.env[SURFACE] = "single";
    expect(resolveInstructions()).toBe(CODESIFT_INSTRUCTIONS_SINGLE);
    expect(CODESIFT_INSTRUCTIONS_SINGLE.length).toBeLessThan(HOST_INSTRUCTIONS_CHAR_CAP);
    for (const name of SINGLE_TOOL_SURFACE) expect(CODESIFT_INSTRUCTIONS_SINGLE).toContain(name);
    for (const absent of ["search_symbols", "get_symbol(", "plan_turn", "find_and_show"]) {
      expect(CODESIFT_INSTRUCTIONS_SINGLE).not.toContain(absent);
    }
  });

  it("uses the default instructions when an explicit visible list overrides the surface", () => {
    process.env[SURFACE] = "single";
    process.env[VISIBLE] = "search_text";
    expect(resolveInstructions()).toBe(CODESIFT_INSTRUCTIONS_SERVER);
  });

  // explore is reachable on demand but must not grow the default Claude Code list (3e1ec6c).
  it("keeps explore out of the default core surface", () => {
    expect(CORE_TOOL_NAMES.has("explore")).toBe(false);
  });
});
