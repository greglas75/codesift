// Second batch of verified adversarial-review findings, plus the systemd escaping gap. Each test
// states the wrong behaviour rather than the patch, because the patch is one line and the reason is
// the part worth keeping.
import { describe, it, expect } from "vitest";
import { systemdEnv } from "../../src/cli/service.js";

describe("systemdEnv", () => {
  it("quotes the whole assignment so whitespace cannot truncate the value", () => {
    // Unquoted, `Environment=K=a b` gives systemd `K=a` and treats `b` as another assignment.
    expect(systemdEnv("CODESIFT_HTTP_TOKEN", "a b")).toBe('"CODESIFT_HTTP_TOKEN=a b"');
  });

  it("escapes quotes and backslashes rather than letting them close the quoting", () => {
    expect(systemdEnv("K", 'a"b')).toBe('"K=a\\"b"');
    expect(systemdEnv("K", "a\\b")).toBe('"K=a\\\\b"');
  });

  it("REFUSES a newline instead of writing half a credential", () => {
    // A newline ends the directive: everything after it is parsed as more unit configuration, which
    // is the injection. systemd cannot carry it in an Environment= value at all, so mangling it
    // silently would leave a token that does not match the one the user was given.
    expect(() => systemdEnv("K", "abc\ndef")).toThrow(/newline or NUL/);
    expect(() => systemdEnv("K", "abc\r\ndef")).toThrow(/newline or NUL/);
    expect(() => systemdEnv("K", "abc\0def")).toThrow(/newline or NUL/);
  });

  it("leaves an ordinary generated token untouched apart from quoting", () => {
    const token = "9f2c1b7ae4d84f0a";
    expect(systemdEnv("CODESIFT_HTTP_TOKEN", token)).toBe(`"CODESIFT_HTTP_TOKEN=${token}"`);
  });
});
