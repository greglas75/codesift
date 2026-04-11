import { describe, it, expect } from "vitest";
import {
  findPackageRoot,
  detectSrcLayout,
  resolvePythonImport,
} from "../../src/utils/python-import-resolver.js";

describe("findPackageRoot", () => {
  it("returns the innermost package containing the file", () => {
    const files = new Set([
      "myapp/__init__.py",
      "myapp/models/__init__.py",
      "myapp/models/user.py",
    ]);
    const root = findPackageRoot("myapp/models/user.py", files);
    expect(root).toBe("myapp/models");
  });

  it("returns the file's directory when no __init__.py ancestor", () => {
    const files = new Set(["scripts/top.py"]);
    const root = findPackageRoot("scripts/top.py", files);
    expect(root).toBe("scripts");
  });

  it("walks up through nested packages", () => {
    const files = new Set([
      "a/__init__.py",
      "a/b/__init__.py",
      "a/b/c/__init__.py",
      "a/b/c/d.py",
    ]);
    expect(findPackageRoot("a/b/c/d.py", files)).toBe("a/b/c");
  });

  it("handles file at repo root", () => {
    const files = new Set(["script.py"]);
    expect(findPackageRoot("script.py", files)).toBe("");
  });
});

describe("detectSrcLayout", () => {
  it("detects a src/ directory with package inside", () => {
    const files = [
      "src/myapp/__init__.py",
      "src/myapp/models.py",
      "README.md",
    ];
    expect(detectSrcLayout(files)).toBe("src");
  });

  it("returns null when no src/ layout", () => {
    const files = ["myapp/__init__.py", "myapp/models.py"];
    expect(detectSrcLayout(files)).toBeNull();
  });

  it("returns null for src/ without packages inside", () => {
    const files = ["src/just-files.py"];
    expect(detectSrcLayout(files)).toBeNull();
  });
});

describe("resolvePythonImport", () => {
  it("resolves relative single-dot import to sibling file", () => {
    const files = [
      "myapp/__init__.py",
      "myapp/models/__init__.py",
      "myapp/models/user.py",
      "myapp/models/utils.py",
    ];
    const result = resolvePythonImport(
      { module: "utils", level: 1 },
      "myapp/models/user.py",
      files,
    );
    expect(result).toBe("myapp/models/utils.py");
  });

  it("resolves relative two-dot import to grandparent module", () => {
    const files = [
      "myapp/__init__.py",
      "myapp/models.py",
      "myapp/services/__init__.py",
      "myapp/services/user.py",
    ];
    const result = resolvePythonImport(
      { module: "models", level: 2 },
      "myapp/services/user.py",
      files,
    );
    expect(result).toBe("myapp/models.py");
  });

  it("resolves from . import sibling without module", () => {
    const files = [
      "myapp/__init__.py",
      "myapp/a.py",
      "myapp/b.py",
    ];
    // `from . import b` — module empty, just import the package itself
    const result = resolvePythonImport(
      { module: "", level: 1 },
      "myapp/a.py",
      files,
    );
    // Should resolve to the package __init__.py
    expect(result).toBe("myapp/__init__.py");
  });

  it("resolves absolute import to .py file", () => {
    const files = [
      "myapp/__init__.py",
      "myapp/models.py",
      "other.py",
    ];
    const result = resolvePythonImport(
      { module: "myapp.models", level: 0 },
      "other.py",
      files,
    );
    expect(result).toBe("myapp/models.py");
  });

  it("resolves absolute import to __init__.py", () => {
    const files = [
      "myapp/__init__.py",
      "myapp/models/__init__.py",
      "other.py",
    ];
    const result = resolvePythonImport(
      { module: "myapp.models", level: 0 },
      "other.py",
      files,
    );
    expect(result).toBe("myapp/models/__init__.py");
  });

  it("resolves absolute import with src/ layout", () => {
    const files = [
      "src/myapp/__init__.py",
      "src/myapp/models.py",
      "tests/test_models.py",
    ];
    const result = resolvePythonImport(
      { module: "myapp.models", level: 0 },
      "tests/test_models.py",
      files,
    );
    expect(result).toBe("src/myapp/models.py");
  });

  it("returns null for stdlib imports", () => {
    const files = ["myapp/__init__.py", "myapp/x.py"];
    const result = resolvePythonImport(
      { module: "os", level: 0 },
      "myapp/x.py",
      files,
    );
    expect(result).toBeNull();
  });

  it("returns null for third-party imports", () => {
    const files = ["myapp/__init__.py"];
    const result = resolvePythonImport(
      { module: "numpy", level: 0 },
      "myapp/x.py",
      files,
    );
    expect(result).toBeNull();
  });

  it("returns null when relative import goes above package root", () => {
    const files = ["a.py"];
    const result = resolvePythonImport(
      { module: "x", level: 6 },
      "a.py",
      files,
    );
    expect(result).toBeNull();
  });
});
