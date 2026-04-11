import { describe, it, expect } from "vitest";
import { parsePyprojectContent } from "../../src/tools/pyproject-tools.js";

const SAMPLE_PYPROJECT = `
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "myapp"
version = "1.2.3"
requires-python = ">=3.11"
dependencies = [
    "django>=4.2",
    "celery~=5.3",
    "pydantic[email]>=2.0",
    "requests",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "ruff",
]
docs = [
    "mkdocs",
]

[project.scripts]
myapp = "myapp.cli:main"
worker = "myapp.worker:start"

[tool.ruff]
line-length = 120

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.mypy]
strict = true
`;

describe("parsePyprojectContent", () => {
  it("extracts project name, version, requires-python", () => {
    const info = parsePyprojectContent(SAMPLE_PYPROJECT, "pyproject.toml");
    expect(info.name).toBe("myapp");
    expect(info.version).toBe("1.2.3");
    expect(info.requires_python).toBe(">=3.11");
  });

  it("extracts build system", () => {
    const info = parsePyprojectContent(SAMPLE_PYPROJECT, "pyproject.toml");
    expect(info.build_system).toBe("hatchling.build");
  });

  it("extracts dependencies with version constraints", () => {
    const info = parsePyprojectContent(SAMPLE_PYPROJECT, "pyproject.toml");
    expect(info.dependencies).toHaveLength(4);
    expect(info.dependencies.find((d) => d.name === "django")).toMatchObject({
      name: "django",
      version: ">=4.2",
    });
    expect(info.dependencies.find((d) => d.name === "requests")).toMatchObject({
      name: "requests",
      version: "*",
    });
    expect(info.dependencies.find((d) => d.name === "pydantic")).toMatchObject({
      name: "pydantic",
      version: ">=2.0",
    });
  });

  it("extracts optional dependency groups", () => {
    const info = parsePyprojectContent(SAMPLE_PYPROJECT, "pyproject.toml");
    expect(info.optional_dependencies.dev).toContain("pytest");
    expect(info.optional_dependencies.dev).toContain("ruff");
    expect(info.optional_dependencies.docs).toContain("mkdocs");
  });

  it("extracts scripts/entry points", () => {
    const info = parsePyprojectContent(SAMPLE_PYPROJECT, "pyproject.toml");
    expect(info.scripts.myapp).toBe("myapp.cli:main");
    expect(info.scripts.worker).toBe("myapp.worker:start");
  });

  it("detects configured tools", () => {
    const info = parsePyprojectContent(SAMPLE_PYPROJECT, "pyproject.toml");
    expect(info.configured_tools).toContain("ruff");
    expect(info.configured_tools).toContain("pytest");
    expect(info.configured_tools).toContain("mypy");
  });

  it("handles minimal pyproject without optional sections", () => {
    const minimal = `
[project]
name = "tiny"
version = "0.1.0"
dependencies = []
`;
    const info = parsePyprojectContent(minimal, "pyproject.toml");
    expect(info.name).toBe("tiny");
    expect(info.dependencies).toHaveLength(0);
    expect(info.configured_tools).toHaveLength(0);
  });
});
