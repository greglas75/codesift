"""
Ripgrep adapter — maps benchmark tasks to rg commands.

Demonstrates how to add a new tool adapter:
1. Implement ToolAdapter with adapter_id and _execute_task
2. Map task categories to tool commands
3. Register in config.yaml
"""

from .base import ToolAdapter, TaskResult


class RipgrepAdapter(ToolAdapter):

    @property
    def adapter_id(self) -> str:
        return "ripgrep"

    def _execute_task(self, repo_path: str, task: dict, result: TaskResult) -> None:
        category = task["category"]

        strategy = getattr(self, f"_strategy_{category}", None)
        if not strategy:
            result.error = f"Ripgrep cannot handle category: {category}"
            return

        strategy(repo_path, task, result)

    # ----- Category strategies -----

    def _strategy_text(self, repo_path: str, task: dict, result: TaskResult):
        """Text search — ripgrep's strength."""
        task_id = task["id"]
        exclude = "--glob=!*.test.* --glob=!*.spec.* --glob=!*__tests__* --glob=!node_modules --glob=!vendor --glob=!dist"

        patterns = {
            "text-001": f"rg -n 'TODO|FIXME|HACK' {exclude} .",
            "text-002": f"rg -n 'process\\.env|os\\.environ|os\\.Getenv|\\$_ENV|getenv' {exclude} .",
            "text-003": f"rg -n -U 'catch.*\\{{\\s*\\}}' {exclude} .",
            "text-004": f"rg -n 'console\\.(log|debug|info)' {exclude} .",
            "text-005": f"rg -n 'as any|as never|# type: ignore|@SuppressWarnings|noinspection' {exclude} .",
        }

        cmd = patterns.get(task_id, f"rg -n '{task['question'][:50]}' {exclude} .")
        call = self.run_command(cmd, cwd=repo_path)
        result.calls.append(call)
        result.raw_output = call.stdout
        result.parsed_items = self.parse_lines(call.stdout)
        result.result_count = len(result.parsed_items)
        result.success = call.returncode == 0 and result.result_count > 0

    def _strategy_symbol(self, repo_path: str, task: dict, result: TaskResult):
        """Symbol search — approximate with grep patterns."""
        task_id = task["id"]

        patterns = {
            "symbol-001": "rg -n '(function|def|func)\\s+(login|authenticate|signIn)' --type-add 'code:*.{ts,tsx,js,py,go,rs,java,php}' -t code .",
            "symbol-002": "rg -n '^export (function|class|const|type|interface)' --glob='*service*' --glob='*Service*' .",
            "symbol-003": "rg -n '(z\\.object|Joi\\.|@IsString|class.*Dto|BaseModel)' .",
            "symbol-004": "rg -n '(createUser|registerUser|signUp|create_user|register_user)' .",
            "symbol-005": "rg -n '(function|const|def)\\s+(make|create|build|fake|mock)[A-Z]' --glob='*.test.*' --glob='*.spec.*' .",
        }

        cmd = patterns.get(task_id, f"rg -n '{task['question'][:30]}' .")
        call = self.run_command(cmd, cwd=repo_path)
        result.calls.append(call)
        result.raw_output = call.stdout
        result.parsed_items = self.parse_lines(call.stdout)
        result.result_count = len(result.parsed_items)
        result.success = call.returncode == 0 and result.result_count > 0

    def _strategy_structure(self, repo_path: str, task: dict, result: TaskResult):
        """Structure — use find + wc."""
        task_id = task["id"]

        if task_id == "structure-001":
            call = self.run_command("find . -maxdepth 2 -type d | sort | head -50", cwd=repo_path)
        elif task_id == "structure-002":
            call = self.run_command(
                "find . -name '*.ts' -o -name '*.py' -o -name '*.go' -o -name '*.php' | "
                "xargs wc -l 2>/dev/null | sort -rn | head -12",
                cwd=repo_path
            )
        elif task_id == "structure-003":
            call = self.run_command(
                "rg -n '@(Get|Post|Put|Patch|Delete)|router\\.(get|post|put|patch|delete)|@app\\.(get|post|route)' .",
                cwd=repo_path
            )
        else:
            call = self.run_command("find . -name 'index.ts' -o -name '__init__.py' | head -20", cwd=repo_path)

        result.calls.append(call)
        result.raw_output = call.stdout
        result.parsed_items = self.parse_lines(call.stdout)
        result.result_count = len(result.parsed_items)
        result.success = call.returncode == 0

    def _strategy_retrieval(self, repo_path: str, task: dict, result: TaskResult):
        """Code retrieval — grep to find file, then cat to read it."""
        keywords = self._extract_keywords(task["question"])
        call1 = self.run_command(f"rg -l '{keywords}' . | head -5", cwd=repo_path)
        result.calls.append(call1)

        if call1.stdout.strip():
            first_file = call1.stdout.strip().split("\n")[0]
            call2 = self.run_command(f"cat -n {first_file}", cwd=repo_path)
            result.calls.append(call2)
            result.raw_output = call2.stdout
            result.parsed_items = [first_file]
        else:
            result.raw_output = call1.stdout

        result.result_count = len(result.parsed_items)
        result.success = bool(result.raw_output.strip())

    def _strategy_relationship(self, repo_path: str, task: dict, result: TaskResult):
        """Relationship — multi-step grep (limited capability)."""
        call1 = self.run_command(
            "rg -n '(function|def|func|class).*([Ll]ogin|[Aa]uth|[Cc]reate)' . | head -20",
            cwd=repo_path
        )
        result.calls.append(call1)

        if call1.stdout.strip():
            first_line = call1.stdout.strip().split("\n")[0]
            func_name = first_line.split("(")[0].split()[-1] if "(" in first_line else "unknown"
            call2 = self.run_command(f"rg -n '{func_name}' . | head -20", cwd=repo_path)
            result.calls.append(call2)
            result.raw_output = call1.stdout + "\n---\n" + call2.stdout
        else:
            result.raw_output = call1.stdout

        result.parsed_items = self.parse_lines(result.raw_output)
        result.result_count = len(result.parsed_items)
        result.success = bool(result.raw_output.strip())

    def _strategy_semantic(self, repo_path: str, task: dict, result: TaskResult):
        """Semantic — grep can't do this well. Best effort with keywords."""
        keywords = self._extract_keywords(task["question"])
        cmd = f"rg -n '{keywords}' . | head -30"
        call = self.run_command(cmd, cwd=repo_path)
        result.calls.append(call)
        result.raw_output = call.stdout
        result.parsed_items = self.parse_lines(call.stdout)
        result.result_count = len(result.parsed_items)
        result.success = bool(call.stdout.strip())

    def _strategy_analysis(self, repo_path: str, task: dict, result: TaskResult):
        """Analysis — very limited with grep."""
        task_id = task["id"]

        if task_id == "analysis-001":
            call = self.run_command(
                "rg -n '^export (function|class|const|type)' . --glob='!*.test.*' | head -30",
                cwd=repo_path
            )
        elif task_id == "analysis-002":
            call = self.run_command("echo 'Clone detection not supported by ripgrep'", cwd=repo_path)
            result.error = "Clone detection not supported"
        elif task_id == "analysis-003":
            call = self.run_command(
                "find . -name '*.ts' -o -name '*.py' | xargs wc -l 2>/dev/null | sort -rn | head -10",
                cwd=repo_path
            )
        else:
            call = self.run_command("echo 'Not supported'", cwd=repo_path)

        result.calls.append(call)
        result.raw_output = call.stdout
        result.parsed_items = self.parse_lines(call.stdout)
        result.result_count = len(result.parsed_items)
        result.success = call.returncode == 0 and bool(call.stdout.strip())

    # ----- Helpers -----

    @staticmethod
    def _extract_keywords(question: str) -> str:
        """Pull likely search terms from natural language question."""
        stop_words = {"the", "a", "an", "in", "of", "how", "does", "is", "are",
                      "what", "this", "that", "and", "or", "to", "for", "with",
                      "from", "by", "all", "each", "show", "find", "list", "explain",
                      "main", "used", "work", "works", "across", "between"}
        words = question.lower().replace("?", "").replace(".", "").split()
        keywords = [w for w in words if w not in stop_words and len(w) > 2]
        return "|".join(keywords[:5])
