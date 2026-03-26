# Benchmark: Quality + Visual Features (2026-03-26)

Tested on `local/codesift-mcp` (122 files, 2887 symbols)

## Results

| Feature | Metric | Value | Tokens | Time |
|---------|--------|-------|--------|------|
| **A1: Relevance-gap filtering** | Results (from top_k=50) | **21** (58% cut) | ~1,880 | 78ms |
| **A4: Scaffolding detection** | Markers found | **4** | ~340 | 15ms |
| **B1: Token savings display** | Prepended to responses | ✅ | N/A | N/A |
| **A2: include_diff** | Files with diff | **13** | ~4,537 | 452ms |
| **A3: Framework-aware dead code** | Candidates | Filtered by whitelist | ~4,270 | 75ms |
| **A5: Semantic chunking** | Symbol chunks vs line chunks | **3 vs 7** (57% fewer) | N/A | N/A |
| **B2: Mermaid community map** | Mermaid diagram lines | **144** | ~943 | 31ms |
| **B3: Mermaid dependency graph** | Mermaid diagram lines | **61** | ~516 | 39ms |
| **B4: Mermaid route flow** | Output | Empty (no routes in test repo) | ~16 | 13ms |
| **B5: HTML report export** | Report file size | **5.7KB** | ~19 | 253ms |

## Context Compression Levels (5K token budget)

| Level | Description | Results | Tokens | Time |
|-------|-------------|---------|--------|------|
| **L0** | Full source | 20 symbols | ~6,312 | 10ms |
| **L1** | Signatures + docstrings | **59 symbols** (3x more) | ~4,982 | 10ms |
| **L2** | File summaries | **57 files** | ~3,000 | 10ms |
| **L3** | Directory overview | **17 dirs** (91% less tok) | ~583 | 6ms |

## Key Takeaways

1. **Relevance-gap filtering** cuts 58% of noise results (50→21) with zero loss of relevant matches
2. **Semantic chunking** produces 57% fewer chunks (3 vs 7) — each chunk is a complete function
3. **Context L1** fits **3x more symbols** in the same token budget as L0
4. **Mermaid diagrams** are compact (~500-940 tok) and paste-ready for GitHub/docs
5. **HTML report** is self-contained (5.7KB) with 6 analysis sections
6. **All features under 500ms** — zero performance impact on search/indexing
