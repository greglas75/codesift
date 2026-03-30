"""
CodeSift adapter — maps benchmark tasks to codesift CLI commands.

Each task category maps to specific CodeSift tools:
  text       → search / patterns
  symbol     → symbols (with keyword extraction)
  structure  → tree / complexity / repo-outline
  retrieval  → retrieve (hybrid) / context / find
  relationship → refs / trace / impact / knowledge-map
  semantic   → retrieve (semantic mode)
  analysis   → dead-code / find-clones / hotspots
"""

import json
import re
from .base import ToolAdapter, TaskResult


# Keywords to strip from natural language questions before searching
STOP_WORDS = frozenset({
    "the", "a", "an", "in", "of", "how", "does", "is", "are", "was", "were",
    "what", "this", "that", "and", "or", "to", "for", "with", "from", "by",
    "all", "each", "show", "find", "list", "explain", "used", "work", "works",
    "across", "between", "main", "every", "using", "their", "which", "where",
    "when", "about", "through", "also", "not", "but", "them", "these", "those",
    "has", "have", "had", "been", "being", "can", "could", "would", "should",
    "its", "it", "they", "there", "here", "any", "some", "most", "other",
    "than", "then", "only", "very", "such", "get", "set", "do", "did",
    "codebase", "code", "file", "files", "function", "method", "class",
    "module", "variable", "type", "interface", "specifically", "responsible",
})


def extract_search_keywords(question: str, max_keywords: int = 5) -> str:
    """Extract likely search terms from a natural language question."""
    words = re.sub(r'[^\w\s/-]', '', question.lower()).split()
    keywords = [w for w in words if w not in STOP_WORDS and len(w) > 2]
    return " ".join(keywords[:max_keywords])


class CodeSiftAdapter(ToolAdapter):

    @property
    def adapter_id(self) -> str:
        return "codesift"

    def setup(self, repo_path: str) -> None:
        """Index repo if not already indexed."""
        repo_name = self._repo_name(repo_path)

        # Check if already indexed
        check = self.run_command(["codesift", "repos"], timeout=10)
        if f"local/{repo_name}" in check.stdout:
            return  # already indexed

        call = self.run_command(["codesift", "index", repo_path], timeout=300)
        if call.returncode != 0:
            raise RuntimeError(f"CodeSift index failed: {call.stderr[:500]}")

    def _execute_task(self, repo_path: str, task: dict, result: TaskResult) -> None:
        category = task["category"]

        strategy = getattr(self, f"_strategy_{category}", None)
        if not strategy:
            result.error = f"No strategy for category: {category}"
            return

        strategy(repo_path, task, result)

    # ----- Category strategies -----

    def _strategy_text(self, repo_path: str, task: dict, result: TaskResult):
        """Text search — use search or patterns."""
        task_id = task["id"]
        repo = self._repo_name(repo_path)

        # --context-lines 0 --compact for fair token comparison with ripgrep
        ctx0 = ["--context-lines", "0", "--compact"]
        strategies = {
            "text-001": ["codesift", "search", f"local/{repo}", "TODO|FIXME|HACK", "--file-pattern", "!*.test.*", "--regex"] + ctx0,
            "text-002": ["codesift", "search", f"local/{repo}", "process\\.env|os\\.environ|os\\.Getenv|\\$_ENV|getenv", "--regex"] + ctx0,
            "text-003": ["codesift", "patterns", f"local/{repo}", "--pattern", "empty-catch"],
            "text-004": ["codesift", "search", f"local/{repo}", "console\\.(log|debug|info)", "--file-pattern", "!*.test.*", "--regex"] + ctx0,
            "text-005": ["codesift", "search", f"local/{repo}", "as any|as never|type: ignore|noinspection|SuppressWarnings", "--file-pattern", "!*.test.*", "--regex"] + ctx0,
        }

        cmd = strategies.get(task_id)
        if cmd:
            call = self.run_command(cmd)
        else:
            # Fallback: extract pattern from question
            keywords = extract_search_keywords(task["question"])
            call = self.run_command([
                "codesift", "search", f"local/{repo}", keywords
            ])

        result.calls.append(call)
        result.raw_output = call.stdout
        result.parsed_items = self.parse_lines(call.stdout)
        result.result_count = len(result.parsed_items)
        result.success = call.returncode == 0 and result.result_count > 0

    def _strategy_symbol(self, repo_path: str, task: dict, result: TaskResult):
        """Symbol search — extract keywords, use symbols command."""
        task_id = task["id"]
        repo = self._repo_name(repo_path)

        # Task-specific keyword extraction
        keyword_map = {
            "symbol-001": "login authenticate signIn auth",
            "symbol-002": None,  # use repo-outline for service layer
            "symbol-003": "schema validator Dto BaseModel",
            "symbol-004": "createUser registerUser signUp create_user",
            "symbol-005": "make create build fake mock",
        }

        if task_id == "symbol-002":
            # List exports in service layer — use repo-outline
            call = self.run_command([
                "codesift", "symbols", f"local/{repo}",
                "service", "--detail", "compact", "--token-budget", "5000",
                "--file-pattern", "*service*"
            ])
        elif task_id == "symbol-005":
            # Test factories — search in test files
            call = self.run_command([
                "codesift", "symbols", f"local/{repo}",
                keyword_map[task_id],
                "--detail", "compact", "--token-budget", "4000",
                "--file-pattern", "*.test.*"
            ])
        elif task_id in keyword_map and keyword_map[task_id]:
            call = self.run_command([
                "codesift", "symbols", f"local/{repo}",
                keyword_map[task_id],
                "--detail", "compact", "--token-budget", "4000"
            ])
        else:
            keywords = extract_search_keywords(task["question"])
            call = self.run_command([
                "codesift", "symbols", f"local/{repo}",
                keywords, "--detail", "compact", "--token-budget", "4000"
            ])

        result.calls.append(call)
        result.raw_output = call.stdout
        result.parsed_items = self.parse_lines(call.stdout)
        result.result_count = len(result.parsed_items)
        result.success = call.returncode == 0 and result.result_count > 0

    def _strategy_structure(self, repo_path: str, task: dict, result: TaskResult):
        """Structure — use file tree, outline, or complexity."""
        task_id = task["id"]
        repo = self._repo_name(repo_path)

        if task_id == "structure-001":
            call = self.run_command([
                "codesift", "tree", f"local/{repo}", "--depth", "2", "--compact"
            ])
        elif task_id == "structure-002":
            call = self.run_command([
                "codesift", "complexity", f"local/{repo}", "--compact"
            ])
        elif task_id == "structure-003":
            # Route discovery — search for route decorators/handlers
            call = self.run_command([
                "codesift", "symbols", f"local/{repo}",
                "route handler endpoint get post put delete patch",
                "--detail", "compact", "--token-budget", "5000"
            ])
        elif task_id == "structure-004":
            call = self.run_command([
                "codesift", "search", f"local/{repo}",
                "export.*from", "--file-pattern", "index.*", "--regex"
            ])
        else:
            call = self.run_command([
                "codesift", "repo-outline", f"local/{repo}", "--compact"
            ])

        result.calls.append(call)
        result.raw_output = call.stdout
        result.parsed_items = self.parse_lines(call.stdout)
        result.result_count = len(result.parsed_items)
        result.success = call.returncode == 0 and result.result_count > 0

    def _strategy_retrieval(self, repo_path: str, task: dict, result: TaskResult):
        """Code retrieval — use hybrid codebase_retrieval."""
        task_id = task["id"]
        repo = self._repo_name(repo_path)
        question = task["question"]

        if task_id == "retrieval-004":
            # "3 most important functions" → use context assembly L1
            keywords = extract_search_keywords(question)
            query = json.dumps([
                {"type": "hybrid", "query": keywords, "top_k": 5}
            ])
        else:
            keywords = extract_search_keywords(question)
            query = json.dumps([
                {"type": "hybrid", "query": keywords, "top_k": 8}
            ])

        call = self.run_command([
            "codesift", "retrieve", f"local/{repo}",
            "--queries", query, "--compact"
        ])
        result.calls.append(call)
        result.raw_output = call.stdout
        result.parsed_items = self.parse_lines(call.stdout)
        result.result_count = len(result.parsed_items)
        result.success = call.returncode == 0 and bool(call.stdout.strip())

    def _strategy_relationship(self, repo_path: str, task: dict, result: TaskResult):
        """Relationship — use dedicated trace/refs/impact tools."""
        task_id = task["id"]
        repo = self._repo_name(repo_path)

        if task_id == "relationship-001":
            # "Find all callers of auth function" → refs
            call = self.run_command([
                "codesift", "refs", f"local/{repo}", "login", "--json"
            ])

        elif task_id == "relationship-002":
            # "Trace POST endpoint handler → service → DB" → trace callees
            # First find a create/post handler, then trace it
            call1 = self.run_command([
                "codesift", "symbols", f"local/{repo}",
                "create post handler", "--detail", "compact", "--token-budget", "1000"
            ])
            result.calls.append(call1)

            # Extract first symbol name from output for tracing
            symbol_name = self._extract_first_symbol(call1.stdout)
            if symbol_name:
                call = self.run_command([
                    "codesift", "trace", f"local/{repo}", symbol_name,
                    "--direction", "callees", "--depth", "3", "--include-source"
                ])
            else:
                # Fallback to hybrid retrieval
                query = json.dumps([{"type": "hybrid", "query": "POST create endpoint handler service database", "top_k": 10}])
                call = self.run_command([
                    "codesift", "retrieve", f"local/{repo}", "--queries", query
                ])

        elif task_id == "relationship-003":
            # "Impact if User model changes" → impact analysis
            call = self.run_command([
                "codesift", "refs", f"local/{repo}", "User", "--json"
            ])

        elif task_id == "relationship-004":
            # "Deepest call chain" → trace with high depth
            # First find an entry point
            call1 = self.run_command([
                "codesift", "symbols", f"local/{repo}",
                "main handle process execute run",
                "--detail", "compact", "--token-budget", "1000"
            ])
            result.calls.append(call1)

            symbol_name = self._extract_first_symbol(call1.stdout)
            if symbol_name:
                call = self.run_command([
                    "codesift", "trace", f"local/{repo}", symbol_name,
                    "--direction", "callees", "--depth", "10"
                ])
            else:
                call = self.run_command([
                    "codesift", "trace", f"local/{repo}", "index",
                    "--direction", "callees", "--depth", "10"
                ])

        elif task_id == "relationship-005":
            # "Circular dependencies" → knowledge-map
            call = self.run_command([
                "codesift", "knowledge-map", f"local/{repo}", "--compact"
            ])

        else:
            # Generic: hybrid retrieval
            keywords = extract_search_keywords(task["question"])
            query = json.dumps([{"type": "hybrid", "query": keywords, "top_k": 10}])
            call = self.run_command([
                "codesift", "retrieve", f"local/{repo}", "--queries", query
            ])

        result.calls.append(call)
        result.raw_output = call.stdout
        result.parsed_items = self.parse_lines(call.stdout)
        result.result_count = len(result.parsed_items)
        result.success = call.returncode == 0 and bool(call.stdout.strip())

    def _strategy_semantic(self, repo_path: str, task: dict, result: TaskResult):
        """Semantic search — use codebase_retrieval in semantic mode."""
        question = task["question"]
        repo = self._repo_name(repo_path)

        query = json.dumps([{"type": "semantic", "query": question, "top_k": 10}])
        call = self.run_command([
            "codesift", "retrieve", f"local/{repo}",
            "--queries", query, "--compact"
        ])
        result.calls.append(call)
        result.raw_output = call.stdout
        result.parsed_items = self.parse_lines(call.stdout)
        result.result_count = len(result.parsed_items)
        result.success = call.returncode == 0 and bool(call.stdout.strip())

    def _strategy_analysis(self, repo_path: str, task: dict, result: TaskResult):
        """Analysis — dead code, clones, hotspots."""
        task_id = task["id"]
        repo = self._repo_name(repo_path)

        if task_id == "analysis-001":
            call = self.run_command(["codesift", "dead-code", f"local/{repo}", "--compact"])
        elif task_id == "analysis-002":
            call = self.run_command(["codesift", "find-clones", f"local/{repo}", "--compact"])
        elif task_id == "analysis-003":
            call = self.run_command(["codesift", "hotspots", f"local/{repo}", "--compact"])
        else:
            call = self.run_command(["codesift", "complexity", f"local/{repo}", "--compact"])

        result.calls.append(call)
        result.raw_output = call.stdout
        result.parsed_items = self.parse_lines(call.stdout)
        result.result_count = len(result.parsed_items)
        result.success = call.returncode == 0 and bool(call.stdout.strip())

    # ----- Helpers -----

    @staticmethod
    def _repo_name(repo_path: str) -> str:
        """Extract repo name from path for codesift local/ prefix."""
        return repo_path.rstrip("/").split("/")[-1]

    @staticmethod
    def _extract_first_symbol(symbols_output: str) -> str | None:
        """Extract the first symbol name from compact symbols output.

        Compact format lines look like:
          symbolId  symbolName  kind  file:line
        """
        for line in symbols_output.strip().split("\n"):
            line = line.strip()
            if not line or line.startswith("─") or line.startswith("│"):
                continue
            # Try to extract a function/class name (second column in compact)
            parts = line.split()
            if len(parts) >= 2:
                # Skip header-like lines
                candidate = parts[1] if len(parts) > 2 else parts[0]
                if candidate and not candidate.startswith("-") and len(candidate) > 1:
                    return candidate
        return None
