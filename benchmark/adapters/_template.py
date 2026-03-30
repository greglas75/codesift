"""
TEMPLATE: Copy this file to create a new tool adapter.

Steps:
  1. cp adapters/_template.py adapters/my_tool.py
  2. Rename the class to MyToolAdapter
  3. Set adapter_id to match config.yaml
  4. Implement _strategy_* methods for each category your tool handles
  5. Add to config.yaml:
       - id: my_tool
         module: adapters.my_tool
         class: MyToolAdapter
         description: "My Tool description"
         requires_index: false
  6. Run: python scripts/run_benchmark.py --adapter my_tool

Categories:
  text, symbol, structure, retrieval, relationship, semantic, analysis

You don't need to implement ALL categories. If your tool can't handle
semantic search, just don't implement _strategy_semantic — the framework
will record it as "not supported" for those tasks.
"""

from .base import ToolAdapter, TaskResult


class TemplateAdapter(ToolAdapter):

    @property
    def adapter_id(self) -> str:
        return "my_tool"  # ← must match config.yaml adapter.id

    def setup(self, repo_path: str) -> None:
        """Optional: index/prepare the repo before tasks run."""
        # Example:
        # call = self.run_command(["my-tool", "index", repo_path])
        # if call.returncode != 0:
        #     raise RuntimeError(f"Setup failed: {call.stderr}")
        pass

    def execute_task(self, repo_path: str, task: dict) -> TaskResult:
        result = self.make_result(task, repo_id="")
        category = task["category"]

        strategy = getattr(self, f"_strategy_{category}", None)
        if not strategy:
            result.error = f"{self.adapter_id} cannot handle: {category}"
            return result

        try:
            strategy(repo_path, task, result)
            result.compute_aggregates()
        except Exception as e:
            result.error = str(e)

        return result

    # ---- Implement the categories your tool supports ----

    def _strategy_text(self, repo_path: str, task: dict, result: TaskResult):
        """Text search tasks."""
        # Example:
        # call = self.run_command(["my-tool", "search", task["question"]], cwd=repo_path)
        # result.calls.append(call)
        # result.raw_output = call.stdout
        # result.success = call.returncode == 0
        pass

    # def _strategy_symbol(self, ...): ...
    # def _strategy_structure(self, ...): ...
    # def _strategy_retrieval(self, ...): ...
    # def _strategy_relationship(self, ...): ...
    # def _strategy_semantic(self, ...): ...
    # def _strategy_analysis(self, ...): ...
