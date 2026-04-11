import { initParser, getParser } from "../../src/parser/parser-manager.js";
import { extractGradleKtsSymbols } from "../../src/parser/extractors/gradle-kts.js";

beforeAll(async () => {
  await initParser();
});

async function parseGradleKts(source: string, file = "build.gradle.kts") {
  const parser = await getParser("kotlin");
  expect(parser).not.toBeNull();
  const tree = parser!.parse(source);
  return extractGradleKtsSymbols(tree, file, source, "test-repo");
}

describe("extractGradleKtsSymbols — plugins block", () => {
  it("extracts `kotlin(\"jvm\")` plugin with version", async () => {
    const symbols = await parseGradleKts(`
plugins {
    kotlin("jvm") version "1.9.0"
}
`);
    const plugin = symbols.find((s) => s.name === "jvm");
    expect(plugin).toBeDefined();
    expect(plugin!.meta?.["gradle_type"]).toBe("plugin");
    expect(plugin!.meta?.["declarator"]).toBe("kotlin");
    expect(plugin!.meta?.["version"]).toBe("1.9.0");
  });

  it("extracts `id(\"com.android.application\")` plugin without version", async () => {
    const symbols = await parseGradleKts(`
plugins {
    id("com.android.application")
}
`);
    const plugin = symbols.find((s) => s.name === "com.android.application");
    expect(plugin).toBeDefined();
    expect(plugin!.meta?.["gradle_type"]).toBe("plugin");
    expect(plugin!.meta?.["declarator"]).toBe("id");
  });

  it("extracts multiple plugins", async () => {
    const symbols = await parseGradleKts(`
plugins {
    kotlin("jvm") version "1.9.0"
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.serialization")
}
`);
    const plugins = symbols.filter((s) => s.meta?.["gradle_type"] === "plugin");
    expect(plugins).toHaveLength(3);
    const names = plugins.map((p) => p.name);
    expect(names).toContain("jvm");
    expect(names).toContain("com.android.application");
    expect(names).toContain("org.jetbrains.kotlin.plugin.serialization");
  });
});

describe("extractGradleKtsSymbols — dependencies block", () => {
  it("extracts implementation dependency with full GAV coordinate", async () => {
    const symbols = await parseGradleKts(`
dependencies {
    implementation("io.ktor:ktor-server:2.3.0")
}
`);
    const dep = symbols.find((s) => s.name === "io.ktor:ktor-server:2.3.0");
    expect(dep).toBeDefined();
    expect(dep!.meta?.["gradle_type"]).toBe("dependency");
    expect(dep!.meta?.["configuration"]).toBe("implementation");
  });

  it("distinguishes implementation vs testImplementation configurations", async () => {
    const symbols = await parseGradleKts(`
dependencies {
    implementation("io.ktor:ktor-server:2.3.0")
    testImplementation("org.jetbrains.kotlin:kotlin-test")
    api("com.squareup.okhttp3:okhttp:4.11.0")
}
`);
    const impl = symbols.find((s) => s.name === "io.ktor:ktor-server:2.3.0");
    const test = symbols.find((s) => s.name === "org.jetbrains.kotlin:kotlin-test");
    const api = symbols.find((s) => s.name === "com.squareup.okhttp3:okhttp:4.11.0");
    expect(impl!.meta?.["configuration"]).toBe("implementation");
    expect(test!.meta?.["configuration"]).toBe("testImplementation");
    expect(api!.meta?.["configuration"]).toBe("api");
  });
});

describe("extractGradleKtsSymbols — config blocks (android, kotlin, java)", () => {
  it("extracts android namespace + compileSdk as config entries", async () => {
    const symbols = await parseGradleKts(`
android {
    namespace = "com.example"
    compileSdk = 34
}
`);
    const ns = symbols.find((s) => s.name === "android.namespace");
    const sdk = symbols.find((s) => s.name === "android.compileSdk");
    expect(ns).toBeDefined();
    expect(ns!.meta?.["gradle_type"]).toBe("config");
    expect(ns!.meta?.["value"]).toBe("com.example");
    expect(sdk).toBeDefined();
    expect(sdk!.meta?.["value"]).toBe("34");
  });

  it("extracts kotlin { jvmToolchain } config block", async () => {
    const symbols = await parseGradleKts(`
kotlin {
    jvmToolchain = 17
}
`);
    const tc = symbols.find((s) => s.name === "kotlin.jvmToolchain");
    expect(tc).toBeDefined();
    expect(tc!.meta?.["gradle_type"]).toBe("config");
    expect(tc!.meta?.["value"]).toBe("17");
  });
});

describe("extractGradleKtsSymbols — version catalog (libs.plugins.*)", () => {
  it("extracts `alias(libs.plugins.android.application)` as plugin", async () => {
    const symbols = await parseGradleKts(`
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android)
}
`);
    const plugins = symbols.filter((s) => s.meta?.["gradle_type"] === "plugin");
    expect(plugins).toHaveLength(2);
    const names = plugins.map((p) => p.name);
    // libs.plugins. prefix is stripped so the name matches libs.versions.toml
    expect(names).toContain("android.application");
    expect(names).toContain("kotlin.android");
    for (const p of plugins) {
      expect(p.meta?.["declarator"]).toBe("alias");
    }
  });

  it("extracts `implementation(libs.androidx.core.ktx)` as catalog dependency", async () => {
    const symbols = await parseGradleKts(`
dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.hilt.android)
}
`);
    const deps = symbols.filter((s) => s.meta?.["gradle_type"] === "dependency");
    expect(deps).toHaveLength(2);
    const ktxDep = deps.find((d) => d.name === "libs.androidx.core.ktx");
    expect(ktxDep).toBeDefined();
    expect(ktxDep!.meta?.["configuration"]).toBe("implementation");
    expect(ktxDep!.meta?.["source"]).toBe("catalog");
  });

  it("mixes literal GAV + catalog dependencies in same file", async () => {
    const symbols = await parseGradleKts(`
dependencies {
    implementation(libs.androidx.core.ktx)
    implementation("io.ktor:ktor-server:2.3.0")
}
`);
    const deps = symbols.filter((s) => s.meta?.["gradle_type"] === "dependency");
    expect(deps).toHaveLength(2);
    const catalog = deps.find((d) => d.meta?.["source"] === "catalog");
    const literal = deps.find((d) => d.meta?.["source"] === "literal");
    expect(catalog).toBeDefined();
    expect(literal).toBeDefined();
    expect(literal!.name).toBe("io.ktor:ktor-server:2.3.0");
  });
});

describe("extractGradleKtsSymbols — integration", () => {
  it("handles a complete build.gradle.kts with plugins + dependencies + android", async () => {
    const symbols = await parseGradleKts(`
plugins {
    kotlin("jvm") version "1.9.0"
    id("com.android.application")
}

android {
    namespace = "com.example"
    compileSdk = 34
}

dependencies {
    implementation("io.ktor:ktor-server:2.3.0")
    testImplementation("org.jetbrains.kotlin:kotlin-test")
}
`);
    const plugins = symbols.filter((s) => s.meta?.["gradle_type"] === "plugin");
    const deps = symbols.filter((s) => s.meta?.["gradle_type"] === "dependency");
    const configs = symbols.filter((s) => s.meta?.["gradle_type"] === "config");

    expect(plugins.length).toBeGreaterThanOrEqual(2);
    expect(deps.length).toBeGreaterThanOrEqual(2);
    expect(configs.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty for a non-Gradle Kotlin file", async () => {
    const symbols = await parseGradleKts(`
fun main() {
    println("Hello")
}
`);
    // No plugins/dependencies/android blocks → no gradle symbols
    const gradleSymbols = symbols.filter((s) => s.meta?.["gradle_type"]);
    expect(gradleSymbols).toHaveLength(0);
  });
});
