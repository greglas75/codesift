import { describe, it, expect } from "vitest";
import { BUILTIN_PATTERNS } from "../../src/tools/pattern-tools.js";

/** Helper: test a pattern against source, expect match or no-match */
function testPattern(name: string, source: string, shouldMatch: boolean) {
  const pattern = BUILTIN_PATTERNS[name];
  expect(pattern, `Pattern "${name}" not found`).toBeDefined();
  pattern!.regex.lastIndex = 0;
  const result = pattern!.regex.test(source);
  expect(result, `"${name}" ${shouldMatch ? "should" : "should NOT"} match`).toBe(shouldMatch);
}

describe("Python anti-patterns", () => {
  it("mutable-default: detects [] default", () => {
    testPattern("mutable-default", `def foo(items=[]):\n    pass`, true);
    testPattern("mutable-default", `def foo(items=None):\n    pass`, false);
  });

  it("bare-except: detects except:", () => {
    testPattern("bare-except", `except:\n    pass`, true);
    testPattern("bare-except", `except ValueError:\n    pass`, false);
  });

  it("broad-except: detects except Exception", () => {
    testPattern("broad-except", `except Exception:\n    log(e)`, true);
    testPattern("broad-except", `except ValueError:\n    log(e)`, false);
  });

  it("global-keyword: detects global statement", () => {
    testPattern("global-keyword", `global counter`, true);
    testPattern("global-keyword", `x = 1`, false);
  });

  it("star-import: detects from X import *", () => {
    testPattern("star-import", `from os import *`, true);
    testPattern("star-import", `from os import path`, false);
  });

  it("eval-exec: detects eval() and exec()", () => {
    testPattern("eval-exec", `eval(user_input)`, true);
    testPattern("eval-exec", `exec(code)`, true);
    testPattern("eval-exec", `execute_query()`, false);
  });

  it("shell-true: detects subprocess with shell=True", () => {
    testPattern("shell-true", `subprocess.run(cmd, shell=True)`, true);
    testPattern("shell-true", `subprocess.run(cmd)`, false);
  });

  it("pickle-load: detects pickle deserialization", () => {
    testPattern("pickle-load", `pickle.loads(data)`, true);
    testPattern("pickle-load", `pickle.dump(data, f)`, false);
  });

  it("datetime-naive: detects datetime.now() without tz", () => {
    testPattern("datetime-naive", `datetime.now()`, true);
    testPattern("datetime-naive", `datetime.now(tz=UTC)`, false);
  });

  it("late-binding: detects lambda capturing loop var", () => {
    testPattern("late-binding", `for i in range(10):\n    fns.append(lambda: i)`, true);
  });

  it("assert-tuple: detects assert(expr) tuple form", () => {
    testPattern("assert-tuple", `assert(x > 0, "must be positive")`, true);
    testPattern("assert-tuple", `assert x > 0`, false);
  });

  it("shadow-builtin: detects list = ...", () => {
    testPattern("shadow-builtin", `list = [1, 2, 3]`, true);
    testPattern("shadow-builtin", `my_list = [1, 2, 3]`, false);
  });

  it("string-concat-loop: detects += in loop", () => {
    testPattern("string-concat-loop", `for c in chars:\n    result += str(c)`, true);
  });

  it("n-plus-one-django: detects related access in loop", () => {
    testPattern("n-plus-one-django", `for post in posts:\n    post.comment_set`, true);
  });

  it("all 17 Python patterns exist", () => {
    const pyPatterns = [
      "mutable-default", "bare-except", "broad-except", "global-keyword",
      "star-import", "print-debug-py", "eval-exec", "shell-true",
      "pickle-load", "yaml-unsafe", "open-no-with", "string-concat-loop",
      "datetime-naive", "shadow-builtin", "n-plus-one-django",
      "late-binding", "assert-tuple",
    ];
    for (const name of pyPatterns) {
      expect(BUILTIN_PATTERNS[name], `Missing pattern: ${name}`).toBeDefined();
    }
  });
});
