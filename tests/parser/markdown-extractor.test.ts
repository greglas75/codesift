import { extractMarkdownSymbols } from "../../src/parser/extractors/markdown.js";

describe("extractMarkdownSymbols — sections (Gap 3)", () => {
  it("extracts headings as 'section' kind", () => {
    const source = `# Introduction

Some intro text.

## Getting Started

How to get started.

## API Reference

API docs here.
`;
    const symbols = extractMarkdownSymbols(source, "README.md", "test-repo");

    expect(symbols).toHaveLength(3);
    expect(symbols[0]!.name).toBe("Introduction");
    expect(symbols[0]!.kind).toBe("section");
    expect(symbols[1]!.name).toBe("Getting Started");
    expect(symbols[1]!.kind).toBe("section");
    expect(symbols[2]!.name).toBe("API Reference");
    expect(symbols[2]!.kind).toBe("section");
  });

  it("assigns correct start_line and end_line (1-based)", () => {
    // No trailing newline to avoid ambiguity about empty last line
    const source = [
      "# First",
      "",
      "Content of first.",
      "",
      "# Second",
      "",
      "Content of second.",
    ].join("\n");
    const symbols = extractMarkdownSymbols(source, "doc.md", "test-repo");

    expect(symbols[0]!.start_line).toBe(1);
    // First section ends at the line before "# Second" (line 5), so end_line = 4
    expect(symbols[0]!.end_line).toBe(4);

    expect(symbols[1]!.start_line).toBe(5);
    // Last section extends to EOF = line 7
    expect(symbols[1]!.end_line).toBe(7);
  });

  it("builds hierarchical parent references", () => {
    const source = `# Top Level

## Sub Section

### Deep Section

## Another Sub
`;
    const symbols = extractMarkdownSymbols(source, "doc.md", "test-repo");

    expect(symbols).toHaveLength(4);

    const top = symbols.find((s) => s.name === "Top Level")!;
    const sub = symbols.find((s) => s.name === "Sub Section")!;
    const deep = symbols.find((s) => s.name === "Deep Section")!;
    const another = symbols.find((s) => s.name === "Another Sub")!;

    // Top has no parent
    expect(top.parent).toBeUndefined();
    // Sub is child of Top
    expect(sub.parent).toBe(top.id);
    // Deep is child of Sub
    expect(deep.parent).toBe(sub.id);
    // Another is child of Top (sibling of Sub)
    expect(another.parent).toBe(top.id);
  });

  it("sets signature to heading markdown syntax", () => {
    const source = `# Title

## Subtitle

### Sub-subtitle
`;
    const symbols = extractMarkdownSymbols(source, "doc.md", "test-repo");

    expect(symbols[0]!.signature).toBe("# Title");
    expect(symbols[1]!.signature).toBe("## Subtitle");
    expect(symbols[2]!.signature).toBe("### Sub-subtitle");
  });

  it("includes section source text", () => {
    const source = `# Heading

This is the content.
More content here.

# Next
`;
    const symbols = extractMarkdownSymbols(source, "doc.md", "test-repo");

    const heading = symbols.find((s) => s.name === "Heading")!;
    expect(heading.source).toContain("# Heading");
    expect(heading.source).toContain("This is the content.");
    expect(heading.source).toContain("More content here.");
    // Should NOT include the next heading
    expect(heading.source).not.toContain("# Next");
  });

  it("skips headings inside fenced code blocks", () => {
    const source = `# Real Heading

\`\`\`markdown
# This is code, not a heading
## Also code
\`\`\`

## Another Real Heading
`;
    const symbols = extractMarkdownSymbols(source, "doc.md", "test-repo");

    const sectionNames = symbols.map((s) => s.name);
    expect(sectionNames).toContain("Real Heading");
    expect(sectionNames).toContain("Another Real Heading");
    expect(sectionNames).not.toContain("This is code, not a heading");
    expect(sectionNames).not.toContain("Also code");
  });

  it("returns empty array for markdown with no headings", () => {
    const source = `Just some text without headings.

More text.
`;
    const symbols = extractMarkdownSymbols(source, "notes.md", "test-repo");
    expect(symbols).toHaveLength(0);
  });
});

describe("extractMarkdownSymbols — frontmatter (Gap 3)", () => {
  it("extracts YAML frontmatter as 'metadata' kind", () => {
    const source = `---
title: My Document
date: 2024-01-01
tags: [doc, test]
---

# Content

Some content.
`;
    const symbols = extractMarkdownSymbols(source, "doc.md", "test-repo");

    const frontmatter = symbols.find((s) => s.kind === "metadata");
    expect(frontmatter).toBeDefined();
    expect(frontmatter!.name).toBe("frontmatter");
    expect(frontmatter!.start_line).toBe(1);
    expect(frontmatter!.end_line).toBe(5);
    expect(frontmatter!.source).toContain("title: My Document");
    expect(frontmatter!.docstring).toContain("title: My Document");
  });

  it("does not extract frontmatter when --- is not at line 1", () => {
    const source = `# Title

---
Not frontmatter
---
`;
    const symbols = extractMarkdownSymbols(source, "doc.md", "test-repo");

    const frontmatter = symbols.find((s) => s.kind === "metadata");
    expect(frontmatter).toBeUndefined();
  });

  it("extracts both frontmatter and sections", () => {
    const source = `---
title: Test
---

# Heading One

Content.

## Heading Two

More content.
`;
    const symbols = extractMarkdownSymbols(source, "doc.md", "test-repo");

    const metadata = symbols.filter((s) => s.kind === "metadata");
    const sections = symbols.filter((s) => s.kind === "section");

    expect(metadata).toHaveLength(1);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.name).toBe("Heading One");
    expect(sections[1]!.name).toBe("Heading Two");
  });
});

describe("extractMarkdownSymbols — section summaries", () => {
  it("generates table summary for sections starting with a table", () => {
    const source = `# Config Table

| Name | Value |
|------|-------|
| key1 | val1  |
| key2 | val2  |
| key3 | val3  |
`;
    const symbols = extractMarkdownSymbols(source, "doc.md", "test-repo");

    const section = symbols.find((s) => s.name === "Config Table")!;
    expect(section.docstring).toMatch(/Table: \d+ rows/);
  });

  it("generates code summary for sections starting with a code block", () => {
    const source = `# Example

\`\`\`typescript
const x = 1;
const y = 2;
\`\`\`
`;
    const symbols = extractMarkdownSymbols(source, "doc.md", "test-repo");

    const section = symbols.find((s) => s.name === "Example")!;
    expect(section.docstring).toBe("Code: typescript, 2 lines");
  });

  it("generates paragraph summary for sections starting with text", () => {
    const source = `# Overview

This is a brief overview of the project.
`;
    const symbols = extractMarkdownSymbols(source, "doc.md", "test-repo");

    const section = symbols.find((s) => s.name === "Overview")!;
    expect(section.docstring).toBe("This is a brief overview of the project.");
  });
});
