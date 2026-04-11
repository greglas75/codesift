import { describe, it, expect, beforeAll } from "vitest";
import { initParser, getParser } from "../../src/parser/parser-manager.js";
import { extractPythonImports } from "../../src/utils/python-imports.js";

beforeAll(async () => {
  await initParser();
});

async function parseImports(source: string) {
  const parser = await getParser("python");
  expect(parser).not.toBeNull();
  const tree = parser!.parse(source);
  return extractPythonImports(tree);
}

describe("extractPythonImports", () => {
  it("extracts simple absolute import", async () => {
    const imports = await parseImports(`import os`);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      module: "os",
      level: 0,
      is_type_only: false,
      is_star: false,
    });
  });

  it("extracts dotted module import", async () => {
    const imports = await parseImports(`import os.path`);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.module).toBe("os.path");
  });

  it("extracts multiple imports on one line", async () => {
    const imports = await parseImports(`import a, b, c`);
    expect(imports).toHaveLength(3);
    expect(imports.map((i) => i.module).sort()).toEqual(["a", "b", "c"]);
  });

  it("extracts from-import", async () => {
    const imports = await parseImports(`from pathlib import Path`);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      module: "pathlib",
      level: 0,
    });
  });

  it("extracts relative single-dot import", async () => {
    const imports = await parseImports(`from . import utils`);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      module: "",
      level: 1,
    });
  });

  it("extracts relative two-dot import", async () => {
    const imports = await parseImports(`from .. import models`);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.level).toBe(2);
  });

  it("extracts relative import with module", async () => {
    const imports = await parseImports(`from .helpers import foo`);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      module: "helpers",
      level: 1,
    });
  });

  it("extracts dotted from-import as single entry", async () => {
    const imports = await parseImports(
      `from myapp.models import User, Admin`,
    );
    expect(imports).toHaveLength(1);
    expect(imports[0]!.module).toBe("myapp.models");
  });

  it("flags star imports", async () => {
    const imports = await parseImports(`from mymod import *`);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.is_star).toBe(true);
  });

  it("flags TYPE_CHECKING imports as type_only", async () => {
    const imports = await parseImports(`
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from x import Y
`);
    const typeImport = imports.find((i) => i.module === "x");
    expect(typeImport).toBeDefined();
    expect(typeImport!.is_type_only).toBe(true);
  });

  it("captures both branches of try/except ImportError", async () => {
    const imports = await parseImports(`
try:
    import ujson as json
except ImportError:
    import json
`);
    const modules = imports.map((i) => i.module);
    expect(modules).toContain("ujson");
    expect(modules).toContain("json");
  });

  it("ignores imports inside string literals", async () => {
    const imports = await parseImports(`
x = "import os"
y = '''from . import foo'''
`);
    expect(imports).toHaveLength(0);
  });

  it("ignores imports inside comments", async () => {
    const imports = await parseImports(`
# import os
# from . import foo
`);
    expect(imports).toHaveLength(0);
  });
});
