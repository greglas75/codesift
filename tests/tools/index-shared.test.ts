import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import { EXTRACTOR_VERSIONS as SHARED_EXTRACTOR_VERSIONS } from "../../src/tools/index-shared.js";
import {
  EXTRACTOR_VERSIONS as PROJECT_EXTRACTOR_VERSIONS,
  getExtractorVersions,
} from "../../src/tools/project-tools.js";

describe("index-shared", () => {
  it("keeps project-tools EXTRACTOR_VERSIONS as a compatibility re-export", () => {
    expect(PROJECT_EXTRACTOR_VERSIONS).toBe(SHARED_EXTRACTOR_VERSIONS);
    expect(PROJECT_EXTRACTOR_VERSIONS.typescript).toBe("3.0.0");
  });

  it("uses the shared extractor version registry for getExtractorVersions output", () => {
    const response = getExtractorVersions();

    expect(response.profile_frameworks).toEqual(SHARED_EXTRACTOR_VERSIONS);
    expect(response.versions).toEqual(SHARED_EXTRACTOR_VERSIONS);
  });
});
