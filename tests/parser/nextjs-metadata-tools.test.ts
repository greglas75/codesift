import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/tools/index-tools.js", () => ({
  getCodeIndex: vi.fn(),
}));

import {
  nextjsMetadataAudit,
  scoreMetadata,
} from "../../src/tools/nextjs-metadata-tools.js";
import type { MetadataFields } from "../../src/utils/nextjs.js";

describe("nextjs-metadata-tools exports", () => {
  it("exports nextjsMetadataAudit function", () => {
    expect(typeof nextjsMetadataAudit).toBe("function");
  });
});

describe("scoreMetadata", () => {
  it("scores fully complete metadata as 100 / excellent", () => {
    const fields: MetadataFields = {
      title: "Complete Product Page Title",
      description:
        "A detailed description of exactly 50 or more characters here.",
      openGraph: { images: ["/real-og.jpg"] },
      alternates: { canonical: "/products" },
      twitter: { card: "summary" },
      other: { "application/ld+json": {} },
    };
    const result = scoreMetadata(fields);
    expect(result.score).toBe(100);
    expect(result.grade).toBe("excellent");
  });

  it("scores missing-title at 75 / good", () => {
    const fields: MetadataFields = {
      description:
        "A detailed description of exactly 50 or more characters here.",
      openGraph: { images: ["/real-og.jpg"] },
      alternates: { canonical: "/products" },
      twitter: { card: "summary" },
      other: { "application/ld+json": {} },
    };
    const result = scoreMetadata(fields);
    expect(result.score).toBe(75);
    expect(result.grade).toBe("good");
  });

  it("scores missing-title-and-description at 55 / needs_work", () => {
    const fields: MetadataFields = {
      openGraph: { images: ["/real-og.jpg"] },
      alternates: { canonical: "/products" },
      twitter: { card: "summary" },
      other: { "application/ld+json": {} },
    };
    const result = scoreMetadata(fields);
    expect(result.score).toBe(55);
    expect(result.grade).toBe("needs_work");
  });

  it("scores title-only at 25 / poor", () => {
    const fields: MetadataFields = {
      title: "Complete Product Page Title",
    };
    const result = scoreMetadata(fields);
    expect(result.score).toBe(25);
    expect(result.grade).toBe("poor");
  });

  it("scores empty input at 0 / poor", () => {
    const fields: MetadataFields = {};
    const result = scoreMetadata(fields);
    expect(result.score).toBe(0);
    expect(result.grade).toBe("poor");
  });

  it("flags title_too_short when title under length gate", () => {
    const fields: MetadataFields = {
      title: "Short",
      description:
        "A detailed description of exactly 50 or more characters here.",
    };
    const result = scoreMetadata(fields);
    expect(result.violations).toContain("title_too_short");
    expect(result.score).toBe(20); // title=0, desc=20
  });

  it("flags description_too_short when description under length gate", () => {
    const fields: MetadataFields = {
      title: "Complete Product Page Title",
      description: "Too short",
    };
    const result = scoreMetadata(fields);
    expect(result.violations).toContain("description_too_short");
    expect(result.score).toBe(25); // title=25, desc=0
  });

  it("flags og_image_placeholder when og:image is generic placeholder", () => {
    const fields: MetadataFields = {
      title: "Complete Product Page Title",
      description:
        "A detailed description of exactly 50 or more characters here.",
      openGraph: { images: ["/og-image.png"] },
    };
    const result = scoreMetadata(fields);
    expect(result.violations).toContain("og_image_placeholder");
    expect(result.score).toBe(45); // title=25, desc=20, OG=0
  });
});
