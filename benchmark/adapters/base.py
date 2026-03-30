"""
Base adapter interface for benchmark tools.

To add a new tool:
1. Create adapters/my_tool.py
2. Implement MyToolAdapter(ToolAdapter)
3. Register in config.yaml under adapters:
4. Run: python scripts/run_benchmark.py --adapter my_tool

Every tool call is measured automatically by the base class.
You only implement execute_task() — metrics are collected for you.
"""

import time
import subprocess
import shlex
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

# Token estimation: ~3.7 chars per token for code (tiktoken cl100k_base average).
# Use this consistently everywhere.
CHARS_PER_TOKEN = 3.7


def estimate_tokens(text: str) -> int:
    """Estimate token count from character length."""
    return max(1, int(len(text) / CHARS_PER_TOKEN))


@dataclass
class ToolCall:
    """Single tool/command invocation with metrics."""
    command: str
    wall_clock_ms: int = 0
    output_chars: int = 0
    output_tokens: int = 0
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""


@dataclass
class TaskResult:
    """Complete result of running one task with one adapter."""
    task_id: str = ""
    adapter_id: str = ""
    repo_id: str = ""

    # Aggregated metrics
    success: bool = False
    wall_clock_ms: int = 0          # TRUE wall clock (measured in execute_task wrapper)
    sum_call_ms: int = 0            # Sum of individual call times
    tool_calls_count: int = 0
    total_output_chars: int = 0
    total_output_tokens: int = 0
    result_count: int = 0           # items found (files, symbols, edges)
    precision: float = 0.0
    recall: float = 0.0
    f1: float = 0.0

    # Per-call detail
    calls: list[ToolCall] = field(default_factory=list)

    # Raw output for scoring
    raw_output: str = ""
    parsed_items: list[Any] = field(default_factory=list)

    # Error tracking
    error: str = ""
    timed_out: bool = False

    def compute_aggregates(self):
        """Compute aggregate metrics from individual calls."""
        self.tool_calls_count = len(self.calls)
        self.total_output_chars = sum(c.output_chars for c in self.calls)
        self.total_output_tokens = sum(c.output_tokens for c in self.calls)
        self.sum_call_ms = sum(c.wall_clock_ms for c in self.calls)
        # NOTE: wall_clock_ms is set externally by the wrapper, not from sum

    def to_dict(self) -> dict:
        """Serialize for JSON output."""
        return {
            "task_id": self.task_id,
            "adapter_id": self.adapter_id,
            "repo_id": self.repo_id,
            "success": self.success,
            "wall_clock_ms": self.wall_clock_ms,
            "sum_call_ms": self.sum_call_ms,
            "tool_calls": self.tool_calls_count,
            "total_output_chars": self.total_output_chars,
            "total_output_tokens": self.total_output_tokens,
            "result_count": self.result_count,
            "parsed_items_count": len(self.parsed_items),
            "precision": self.precision,
            "recall": self.recall,
            "f1": self.f1,
            "error": self.error,
            "timed_out": self.timed_out,
            "calls": [
                {
                    "command": c.command,
                    "wall_clock_ms": c.wall_clock_ms,
                    "output_chars": c.output_chars,
                    "output_tokens": c.output_tokens,
                    "returncode": c.returncode,
                }
                for c in self.calls
            ],
        }


class ToolAdapter(ABC):
    """
    Base class for all tool adapters.

    Subclasses implement:
      - _execute_task(repo_path, task, result) — fills result with data
      - adapter_id property

    The base class provides:
      - execute_task() — wraps _execute_task with true wall-clock timing
      - run_command() — executes shell command with automatic metrics
      - parse_lines() — simple line-based output parser
    """

    @property
    @abstractmethod
    def adapter_id(self) -> str:
        """Unique ID matching config.yaml adapter.id"""
        ...

    def execute_task(self, repo_path: str, task: dict) -> TaskResult:
        """
        Execute a benchmark task with true wall-clock measurement.

        Wraps _execute_task to measure total time including inter-call overhead.
        Subclasses should override _execute_task, NOT this method.
        """
        result = self.make_result(task, repo_id="")

        start = time.perf_counter()
        try:
            self._execute_task(repo_path, task, result)
            result.compute_aggregates()
        except Exception as e:
            result.error = str(e)
        finally:
            result.wall_clock_ms = int((time.perf_counter() - start) * 1000)

        return result

    @abstractmethod
    def _execute_task(self, repo_path: str, task: dict, result: TaskResult) -> None:
        """
        Execute a benchmark task and populate result.

        Args:
            repo_path: Absolute path to the repository root
            task: Task dict from universal_tasks.yaml
            result: TaskResult to fill (calls, raw_output, parsed_items, success)
        """
        ...

    def setup(self, repo_path: str) -> None:
        """Optional: run before first task (e.g., index repo). Override if needed."""
        pass

    def teardown(self, repo_path: str) -> None:
        """Optional: cleanup after all tasks. Override if needed."""
        pass

    # ----- Helpers available to all adapters -----

    def run_command(
        self,
        command: str | list[str],
        cwd: str | None = None,
        timeout: int = 120,
    ) -> ToolCall:
        """
        Execute a shell command and measure everything.

        Returns ToolCall with wall_clock_ms, output_chars, output_tokens, etc.
        This is the ONLY way adapters should run external commands —
        ensures consistent measurement across all tools.
        """
        if isinstance(command, list):
            cmd_str = " ".join(shlex.quote(c) for c in command)
            cmd_list = command
        else:
            cmd_str = command
            cmd_list = shlex.split(command)

        call = ToolCall(command=cmd_str)

        try:
            start = time.perf_counter()
            result = subprocess.run(
                cmd_list,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            elapsed = time.perf_counter() - start

            call.wall_clock_ms = int(elapsed * 1000)
            call.stdout = result.stdout
            call.stderr = result.stderr
            call.returncode = result.returncode
            call.output_chars = len(result.stdout)
            call.output_tokens = estimate_tokens(result.stdout)

        except subprocess.TimeoutExpired:
            call.wall_clock_ms = timeout * 1000
            call.returncode = -1
            call.stderr = f"TIMEOUT after {timeout}s"

        except Exception as e:
            call.returncode = -2
            call.stderr = str(e)

        return call

    def make_result(self, task: dict, repo_id: str) -> TaskResult:
        """Create a TaskResult pre-filled with task/adapter/repo IDs."""
        return TaskResult(
            task_id=task["id"],
            adapter_id=self.adapter_id,
            repo_id=repo_id,
        )

    @staticmethod
    def parse_lines(output: str, skip_empty: bool = True) -> list[str]:
        """Parse output into non-empty lines — basic parsed_items."""
        lines = output.strip().split("\n")
        if skip_empty:
            lines = [l for l in lines if l.strip()]
        return lines
