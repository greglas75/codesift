import { describe, it, expect } from "vitest";
import {
  classifyCallEdgeProvenance,
  classifyImportEdgeProvenance,
  formatProvenanceTag,
} from "../../src/utils/edge-provenance.js";

describe("classifyCallEdgeProvenance", () => {
  it("classifies a single resolved candidate as EXTRACTED", () => {
    expect(classifyCallEdgeProvenance(1)).toBe("EXTRACTED");
  });

  it("classifies two candidates as INFERRED (ambiguous resolution)", () => {
    expect(classifyCallEdgeProvenance(2)).toBe("INFERRED");
  });

  it("classifies many candidates as INFERRED", () => {
    expect(classifyCallEdgeProvenance(7)).toBe("INFERRED");
  });

  it("treats zero candidates as EXTRACTED (safe default, not ambiguous)", () => {
    expect(classifyCallEdgeProvenance(0)).toBe("EXTRACTED");
  });

  it("treats a negative candidate count as EXTRACTED (undefined-safe, never throws)", () => {
    expect(() => classifyCallEdgeProvenance(-1)).not.toThrow();
    expect(classifyCallEdgeProvenance(-1)).toBe("EXTRACTED");
  });
});

describe("classifyImportEdgeProvenance", () => {
  it("classifies a star import as INFERRED", () => {
    expect(classifyImportEdgeProvenance({ star_import: true })).toBe("INFERRED");
  });

  it("classifies python-src-layout resolution as INFERRED", () => {
    expect(classifyImportEdgeProvenance({}, "python-src-layout")).toBe("INFERRED");
  });

  it("classifies php-psr4 resolution as INFERRED", () => {
    expect(classifyImportEdgeProvenance({}, "php-psr4")).toBe("INFERRED");
  });

  it("classifies a direct edge with no resolution hint as EXTRACTED", () => {
    expect(classifyImportEdgeProvenance({})).toBe("EXTRACTED");
  });

  it("classifies a direct-resolution edge as EXTRACTED", () => {
    expect(classifyImportEdgeProvenance({}, "direct")).toBe("EXTRACTED");
  });

  it("classifies a workspace-alias-resolved edge as EXTRACTED", () => {
    expect(classifyImportEdgeProvenance({}, "workspace-alias")).toBe("EXTRACTED");
  });

  it("classifies a non-star edge with star_import explicitly false as EXTRACTED", () => {
    expect(classifyImportEdgeProvenance({ star_import: false }, "direct")).toBe("EXTRACTED");
  });
});

describe("formatProvenanceTag", () => {
  it("renders an inferred-edge tag for INFERRED", () => {
    expect(formatProvenanceTag("INFERRED")).toBe(" [inferred]");
  });

  it("renders no tag for EXTRACTED (the default, unannotated case)", () => {
    expect(formatProvenanceTag("EXTRACTED")).toBe("");
  });

  it("renders no tag when provenance is omitted (undefined-safe)", () => {
    expect(formatProvenanceTag()).toBe("");
  });
});
