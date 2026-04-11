import { initParser, getParser } from "../../src/parser/parser-manager.js";
import { extractKotlinSymbols } from "../../src/parser/extractors/kotlin.js";

beforeAll(async () => {
  await initParser();
});

async function parseKotlin(source: string, file = "test.kt") {
  const parser = await getParser("kotlin");
  expect(parser).not.toBeNull();
  const tree = parser!.parse(source);
  return extractKotlinSymbols(tree, file, source, "test-repo");
}

// --- Functions ---

describe("extractKotlinSymbols — functions", () => {
  it("extracts a top-level function", async () => {
    const symbols = await parseKotlin(`
fun greet(name: String): String {
    return "Hello"
}
`);
    const fn = symbols.find((s) => s.name === "greet");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.parent).toBeUndefined();
  });

  it("extracts function signature with params and return type", async () => {
    const symbols = await parseKotlin(`
fun getUser(id: Int, active: Boolean): User {
    return User()
}
`);
    const fn = symbols.find((s) => s.name === "getUser");
    expect(fn).toBeDefined();
    expect(fn!.signature).toContain("(id: Int, active: Boolean)");
    expect(fn!.signature).toContain(": User");
  });

  it("extracts function with nullable return type", async () => {
    const symbols = await parseKotlin(`
fun findById(id: Int): User? {
    return null
}
`);
    const fn = symbols.find((s) => s.name === "findById");
    expect(fn).toBeDefined();
    expect(fn!.signature).toContain(": User?");
  });

  it("extracts function without return type", async () => {
    const symbols = await parseKotlin(`
fun doWork() {
    println("working")
}
`);
    const fn = symbols.find((s) => s.name === "doWork");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
  });
});

// --- Classes ---

describe("extractKotlinSymbols — classes", () => {
  it("extracts a simple class", async () => {
    const symbols = await parseKotlin(`
class UserService {
}
`);
    const cls = symbols.find((s) => s.name === "UserService");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
  });

  it("extracts data class with val/var params as fields", async () => {
    const symbols = await parseKotlin(`
data class User(val name: String, val age: Int)
`);
    const cls = symbols.find((s) => s.name === "User");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");

    const fields = symbols.filter((s) => s.parent === cls!.id);
    expect(fields).toHaveLength(2);

    const nameField = fields.find((f) => f.name === "name");
    expect(nameField).toBeDefined();
    expect(nameField!.kind).toBe("field");

    const ageField = fields.find((f) => f.name === "age");
    expect(ageField).toBeDefined();
    expect(ageField!.kind).toBe("field");
  });

  it("extracts sealed class", async () => {
    const symbols = await parseKotlin(`
sealed class Result
`);
    const cls = symbols.find((s) => s.name === "Result");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
  });

  it("extracts abstract class", async () => {
    const symbols = await parseKotlin(`
abstract class Base {
    abstract fun doWork()
}
`);
    const cls = symbols.find((s) => s.name === "Base");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");

    const method = symbols.find((s) => s.name === "doWork");
    expect(method).toBeDefined();
    expect(method!.kind).toBe("method");
    expect(method!.parent).toBe(cls!.id);
  });

  it("extracts nested classes with parent references", async () => {
    const symbols = await parseKotlin(`
sealed class Result {
    data class Success(val data: String) : Result()
    data class Error(val message: String) : Result()
}
`);
    const result = symbols.find((s) => s.name === "Result");
    expect(result).toBeDefined();

    const success = symbols.find((s) => s.name === "Success");
    expect(success).toBeDefined();
    expect(success!.kind).toBe("class");
    expect(success!.parent).toBe(result!.id);

    const error = symbols.find((s) => s.name === "Error");
    expect(error).toBeDefined();
    expect(error!.parent).toBe(result!.id);
  });

  it("extracts method inside class with parent", async () => {
    const symbols = await parseKotlin(`
class Service {
    fun process(data: String): Boolean {
        return true
    }
}
`);
    const cls = symbols.find((s) => s.name === "Service");
    const method = symbols.find((s) => s.name === "process");
    expect(method).toBeDefined();
    expect(method!.kind).toBe("method");
    expect(method!.parent).toBe(cls!.id);
  });
});

// --- Interfaces ---

describe("extractKotlinSymbols — interfaces", () => {
  it("extracts interface as kind=interface", async () => {
    const symbols = await parseKotlin(`
interface Repository {
    fun findById(id: Int): User?
    fun save(user: User)
}
`);
    const iface = symbols.find((s) => s.name === "Repository");
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe("interface");

    const methods = symbols.filter((s) => s.parent === iface!.id);
    expect(methods).toHaveLength(2);
    expect(methods[0].kind).toBe("method");
    expect(methods[1].kind).toBe("method");
  });

  it("distinguishes interface from class", async () => {
    const symbols = await parseKotlin(`
interface Readable {
    fun read(): String
}

class FileReader {
    fun read(): String { return "" }
}
`);
    const iface = symbols.find((s) => s.name === "Readable");
    expect(iface!.kind).toBe("interface");

    const cls = symbols.find((s) => s.name === "FileReader");
    expect(cls!.kind).toBe("class");
  });
});

// --- Enums ---

describe("extractKotlinSymbols — enums", () => {
  it("extracts enum class with entries as field children", async () => {
    const symbols = await parseKotlin(`
enum class Color {
    RED,
    GREEN,
    BLUE
}
`);
    const cls = symbols.find((s) => s.name === "Color");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");

    const entries = symbols.filter((s) => s.parent === cls!.id);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.name).sort()).toEqual(["BLUE", "GREEN", "RED"]);
    expect(entries.every((e) => e.kind === "field")).toBe(true);
  });
});

// --- Objects ---

describe("extractKotlinSymbols — objects", () => {
  it("extracts object declaration as class", async () => {
    const symbols = await parseKotlin(`
object Singleton {
    val instance = "singleton"
    fun doWork() {}
}
`);
    const obj = symbols.find((s) => s.name === "Singleton");
    expect(obj).toBeDefined();
    expect(obj!.kind).toBe("class");

    const children = symbols.filter((s) => s.parent === obj!.id);
    expect(children).toHaveLength(2);
    expect(children.find((c) => c.name === "instance")!.kind).toBe("field");
    expect(children.find((c) => c.name === "doWork")!.kind).toBe("method");
  });

  it("extracts companion object with methods", async () => {
    const symbols = await parseKotlin(`
class UserService {
    companion object {
        fun create(): UserService = UserService()
    }
}
`);
    const cls = symbols.find((s) => s.name === "UserService");
    expect(cls).toBeDefined();

    const companion = symbols.find((s) => s.name === "Companion");
    expect(companion).toBeDefined();
    expect(companion!.kind).toBe("class");
    expect(companion!.parent).toBe(cls!.id);

    const create = symbols.find((s) => s.name === "create");
    expect(create).toBeDefined();
    expect(create!.kind).toBe("method");
    expect(create!.parent).toBe(companion!.id);
  });

  it("extracts named companion object", async () => {
    const symbols = await parseKotlin(`
class Config {
    companion object Factory {
        fun default(): Config = Config()
    }
}
`);
    const companion = symbols.find((s) => s.name === "Factory");
    expect(companion).toBeDefined();
    expect(companion!.kind).toBe("class");
  });
});

// --- Properties ---

describe("extractKotlinSymbols — properties", () => {
  it("extracts top-level val as variable", async () => {
    const symbols = await parseKotlin(`
val config = "test"
`);
    const prop = symbols.find((s) => s.name === "config");
    expect(prop).toBeDefined();
    expect(prop!.kind).toBe("variable");
    expect(prop!.parent).toBeUndefined();
  });

  it("extracts class-level val as field", async () => {
    const symbols = await parseKotlin(`
class Service {
    val config = "test"
}
`);
    const cls = symbols.find((s) => s.name === "Service");
    const prop = symbols.find((s) => s.name === "config");
    expect(prop).toBeDefined();
    expect(prop!.kind).toBe("field");
    expect(prop!.parent).toBe(cls!.id);
  });

  it("extracts const val as constant", async () => {
    const symbols = await parseKotlin(`
const val MAX_SIZE = 100
`);
    const prop = symbols.find((s) => s.name === "MAX_SIZE");
    expect(prop).toBeDefined();
    expect(prop!.kind).toBe("constant");
  });
});

// --- Type aliases ---

describe("extractKotlinSymbols — type aliases", () => {
  it("extracts typealias as type", async () => {
    const symbols = await parseKotlin(`
typealias StringMap = Map<String, String>
`);
    const ta = symbols.find((s) => s.name === "StringMap");
    expect(ta).toBeDefined();
    expect(ta!.kind).toBe("type");
  });
});

// --- Extension functions ---

describe("extractKotlinSymbols — extension functions", () => {
  it("extracts extension function with receiver in signature", async () => {
    const symbols = await parseKotlin(`
fun String.toSlug(): String {
    return this.lowercase()
}
`);
    const fn = symbols.find((s) => s.name === "toSlug");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.signature).toContain("String.");
  });
});

// --- Suspend functions ---

describe("extractKotlinSymbols — suspend functions", () => {
  it("includes suspend in signature", async () => {
    const symbols = await parseKotlin(`
suspend fun fetchData(): String {
    return "data"
}
`);
    const fn = symbols.find((s) => s.name === "fetchData");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.signature).toContain("suspend");
  });
});

// --- Generics ---

describe("extractKotlinSymbols — generics", () => {
  it("includes type parameters in signature", async () => {
    const symbols = await parseKotlin(`
fun <T> identity(x: T): T = x
`);
    const fn = symbols.find((s) => s.name === "identity");
    expect(fn).toBeDefined();
    expect(fn!.signature).toContain("<T>");
  });

  it("extracts generic suspend extension function", async () => {
    const symbols = await parseKotlin(`
suspend fun <T> List<T>.firstAsync(): T = this.first()
`);
    const fn = symbols.find((s) => s.name === "firstAsync");
    expect(fn).toBeDefined();
    expect(fn!.signature).toContain("suspend");
    expect(fn!.signature).toContain("<T>");
  });
});

// --- KDoc ---

describe("extractKotlinSymbols — KDoc", () => {
  it("extracts KDoc comment as docstring", async () => {
    const symbols = await parseKotlin(`
/** Returns the user by ID */
fun getUser(id: Int): User {
    return User()
}
`);
    const fn = symbols.find((s) => s.name === "getUser");
    expect(fn).toBeDefined();
    expect(fn!.docstring).toBe("/** Returns the user by ID */");
  });

  it("does not extract regular block comments as docstring", async () => {
    const symbols = await parseKotlin(`
/* This is not KDoc */
fun helper() {}
`);
    const fn = symbols.find((s) => s.name === "helper");
    expect(fn).toBeDefined();
    expect(fn!.docstring).toBeUndefined();
  });

  it("extracts KDoc for classes", async () => {
    const symbols = await parseKotlin(`
/** User data class */
data class User(val name: String)
`);
    const cls = symbols.find((s) => s.name === "User");
    expect(cls).toBeDefined();
    expect(cls!.docstring).toBeDefined();
    expect(cls!.docstring).toContain("User data class");
  });
});

// --- Test detection ---

describe("extractKotlinSymbols — test detection", () => {
  it("detects @Test as test_case", async () => {
    const symbols = await parseKotlin(`
import org.junit.jupiter.api.Test

class UserServiceTest {
    @Test
    fun testLogin() {
        assert(true)
    }
}
`);
    const test = symbols.find((s) => s.name === "testLogin");
    expect(test).toBeDefined();
    expect(test!.kind).toBe("test_case");
  });

  it("detects @BeforeEach as test_hook", async () => {
    const symbols = await parseKotlin(`
import org.junit.jupiter.api.BeforeEach

class ServiceTest {
    @BeforeEach
    fun setup() {}
}
`);
    const hook = symbols.find((s) => s.name === "setup");
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe("test_hook");
  });

  it("detects @AfterAll as test_hook", async () => {
    const symbols = await parseKotlin(`
import org.junit.jupiter.api.AfterAll

class ServiceTest {
    @AfterAll
    fun cleanup() {}
}
`);
    const hook = symbols.find((s) => s.name === "cleanup");
    expect(hook).toBeDefined();
    expect(hook!.kind).toBe("test_hook");
  });
});

// --- Compose metadata ---

describe("extractKotlinSymbols — Compose metadata", () => {
  it("classifies @Composable fun as kind=component", async () => {
    const symbols = await parseKotlin(`
@Composable
fun HomeScreen(name: String) {
    Text(name)
}
`);
    const comp = symbols.find((s) => s.name === "HomeScreen");
    expect(comp).toBeDefined();
    expect(comp!.kind).toBe("component");
    expect(comp!.meta?.["compose"]).toBe(true);
  });

  it("flags @Preview composable with meta.compose_preview", async () => {
    const symbols = await parseKotlin(`
@Preview
@Composable
fun HomeScreenPreview() {
    HomeScreen("test")
}
`);
    const preview = symbols.find((s) => s.name === "HomeScreenPreview");
    expect(preview).toBeDefined();
    expect(preview!.kind).toBe("component");
    expect(preview!.meta?.["compose"]).toBe(true);
    expect(preview!.meta?.["compose_preview"]).toBe(true);
  });

  it("does NOT classify non-Composable function as component", async () => {
    const symbols = await parseKotlin(`
fun calculateTotal(items: List<Int>): Int = items.sum()
`);
    const fn = symbols.find((s) => s.name === "calculateTotal");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.meta?.["compose"]).toBeUndefined();
  });

  it("preserves @Composable in decorators field", async () => {
    const symbols = await parseKotlin(`
@Composable
fun UserCard(user: User) { }
`);
    const comp = symbols.find((s) => s.name === "UserCard");
    expect(comp!.decorators).toContain("Composable");
  });

  it("handles @Composable method inside a class", async () => {
    const symbols = await parseKotlin(`
class MyView {
    @Composable
    fun Content() { }
}
`);
    const method = symbols.find((s) => s.name === "Content");
    expect(method).toBeDefined();
    // Methods with @Composable are still "component" (not "method")
    expect(method!.kind).toBe("component");
    expect(method!.meta?.["compose"]).toBe(true);
  });
});

// --- KMP expect / actual ---

describe("extractKotlinSymbols — KMP expect/actual modifiers", () => {
  it("marks `expect class Platform` with kmp_modifier=expect", async () => {
    const symbols = await parseKotlin(`
expect class Platform {
    val name: String
}
`);
    const cls = symbols.find((s) => s.name === "Platform" && s.kind === "class");
    expect(cls).toBeDefined();
    expect(cls!.meta?.["kmp_modifier"]).toBe("expect");
  });

  it("marks `actual class Platform` with kmp_modifier=actual", async () => {
    const symbols = await parseKotlin(`
actual class Platform {
    actual val name: String = "Android"
}
`);
    const cls = symbols.find((s) => s.name === "Platform" && s.kind === "class");
    expect(cls).toBeDefined();
    expect(cls!.meta?.["kmp_modifier"]).toBe("actual");
  });

  it("marks `expect fun getPlatformName()` with kmp_modifier=expect", async () => {
    const symbols = await parseKotlin(`expect fun getPlatformName(): String`);
    const fn = symbols.find((s) => s.name === "getPlatformName");
    expect(fn).toBeDefined();
    expect(fn!.meta?.["kmp_modifier"]).toBe("expect");
  });

  it("marks `actual fun getPlatformName()` with kmp_modifier=actual", async () => {
    const symbols = await parseKotlin(`actual fun getPlatformName(): String = "Android"`);
    const fn = symbols.find((s) => s.name === "getPlatformName");
    expect(fn).toBeDefined();
    expect(fn!.meta?.["kmp_modifier"]).toBe("actual");
  });

  it("does NOT set kmp_modifier on a plain class", async () => {
    const symbols = await parseKotlin(`class Platform { val name: String = "" }`);
    const cls = symbols.find((s) => s.name === "Platform" && s.kind === "class");
    expect(cls).toBeDefined();
    expect(cls!.meta?.["kmp_modifier"]).toBeUndefined();
  });
});

// --- Kotest DSL ---

describe("extractKotlinSymbols — Kotest DSL", () => {
  it("classifies FunSpec subclass as test_suite", async () => {
    const symbols = await parseKotlin(`
class UserSpec : FunSpec({
    test("validates email") {}
})
`);
    const suite = symbols.find((s) => s.name === "UserSpec");
    expect(suite).toBeDefined();
    expect(suite!.kind).toBe("test_suite");
  });

  it("extracts FunSpec test cases with string names", async () => {
    const symbols = await parseKotlin(`
class UserSpec : FunSpec({
    test("validates email") {
        assertTrue(true)
    }
    test("rejects empty email") {}
})
`);
    const cases = symbols.filter((s) => s.kind === "test_case");
    const names = cases.map((c) => c.name);
    expect(names).toContain("validates email");
    expect(names).toContain("rejects empty email");
  });

  it("extracts DescribeSpec nested describe/it as test_case", async () => {
    const symbols = await parseKotlin(`
class UserSpec : DescribeSpec({
    describe("User") {
        it("has a name") {}
        it("has an age") {}
    }
})
`);
    const cases = symbols.filter((s) => s.kind === "test_case");
    const names = cases.map((c) => c.name);
    expect(names).toContain("User");
    expect(names).toContain("has a name");
    expect(names).toContain("has an age");
  });

  it("extracts StringSpec inline-string style", async () => {
    const symbols = await parseKotlin(`
class UserSpec : StringSpec({
    "validates email" {
        assertTrue(true)
    }
    "rejects empty email" {}
})
`);
    const suite = symbols.find((s) => s.name === "UserSpec");
    expect(suite).toBeDefined();
    expect(suite!.kind).toBe("test_suite");
    const cases = symbols.filter((s) => s.kind === "test_case");
    const names = cases.map((c) => c.name);
    expect(names).toContain("validates email");
    expect(names).toContain("rejects empty email");
  });

  it("extracts BehaviorSpec given/when/then nesting", async () => {
    const symbols = await parseKotlin(`
class PaymentSpec : BehaviorSpec({
    given("a user") {
        \`when\`("they login") {
            then("they get a token") {}
        }
    }
})
`);
    const cases = symbols.filter((s) => s.kind === "test_case");
    const names = cases.map((c) => c.name);
    expect(names).toContain("a user");
    expect(names).toContain("they login");
    expect(names).toContain("they get a token");
  });

  it("extracts ShouldSpec with context + should nesting", async () => {
    const symbols = await parseKotlin(`
class PaymentSpec : ShouldSpec({
    should("charge card") {}
    context("paid user") {
        should("see pro features") {}
    }
})
`);
    const cases = symbols.filter((s) => s.kind === "test_case");
    const names = cases.map((c) => c.name);
    expect(names).toContain("charge card");
    expect(names).toContain("paid user");
    expect(names).toContain("see pro features");
  });

  it("classifies WordSpec / FeatureSpec / ExpectSpec / AnnotationSpec as test_suite", async () => {
    const sources = [
      `class S : WordSpec({ "x" should { "y" { } } })`,
      `class S : FeatureSpec({ feature("f") { scenario("s") {} } })`,
      `class S : ExpectSpec({ expect("e") {} })`,
      `class S : AnnotationSpec({ })`,
    ];
    for (const src of sources) {
      const symbols = await parseKotlin(src);
      const suite = symbols.find((s) => s.name === "S");
      expect(suite, `expected test_suite for: ${src}`).toBeDefined();
      expect(suite!.kind, `kind for: ${src}`).toBe("test_suite");
    }
  });

  it("does NOT classify a regular class extending a non-Kotest class as test_suite", async () => {
    const symbols = await parseKotlin(`
class UserRepository : BaseRepository({ })
`);
    const cls = symbols.find((s) => s.name === "UserRepository");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
  });

  it("assigns test cases as children of the spec class", async () => {
    const symbols = await parseKotlin(`
class UserSpec : FunSpec({
    test("validates email") {}
})
`);
    const suite = symbols.find((s) => s.name === "UserSpec");
    const testCase = symbols.find((s) => s.name === "validates email");
    expect(testCase).toBeDefined();
    expect(testCase!.parent).toBe(suite!.id);
  });
});

// --- Comprehensive integration ---

describe("extractKotlinSymbols — integration", () => {
  it("handles a complete Kotlin file with mixed declarations", async () => {
    const symbols = await parseKotlin(`
package com.example

/** Repository interface */
interface UserRepository {
    fun findById(id: Int): User?
    fun save(user: User)
}

data class User(val name: String, val age: Int)

enum class Role {
    ADMIN,
    USER,
    GUEST
}

object Database {
    val connection = "db://localhost"
}

class UserService(private val repo: UserRepository) {
    companion object {
        const val MAX_USERS = 1000
    }

    fun getUser(id: Int): User? {
        return repo.findById(id)
    }

    suspend fun fetchRemoteUser(id: Int): User {
        return User("remote", 0)
    }
}

typealias UserList = List<User>

fun String.slugify(): String = this.lowercase().replace(" ", "-")
`);
    // Interface
    expect(symbols.find((s) => s.name === "UserRepository")!.kind).toBe("interface");

    // Data class with fields
    const user = symbols.find((s) => s.name === "User");
    expect(user!.kind).toBe("class");
    const userFields = symbols.filter((s) => s.parent === user!.id && s.kind === "field");
    expect(userFields).toHaveLength(2);

    // Enum with entries
    const role = symbols.find((s) => s.name === "Role");
    expect(role!.kind).toBe("class");
    const entries = symbols.filter((s) => s.parent === role!.id);
    expect(entries).toHaveLength(3);

    // Object
    expect(symbols.find((s) => s.name === "Database")!.kind).toBe("class");

    // Class with companion, methods
    const service = symbols.find((s) => s.name === "UserService");
    expect(service!.kind).toBe("class");

    // Companion with const
    const companion = symbols.find((s) => s.name === "Companion");
    expect(companion!.parent).toBe(service!.id);
    const maxUsers = symbols.find((s) => s.name === "MAX_USERS");
    expect(maxUsers!.kind).toBe("constant");

    // Methods
    expect(symbols.find((s) => s.name === "getUser")!.kind).toBe("method");
    expect(symbols.find((s) => s.name === "fetchRemoteUser")!.kind).toBe("method");
    expect(symbols.find((s) => s.name === "fetchRemoteUser")!.signature).toContain("suspend");

    // Type alias
    expect(symbols.find((s) => s.name === "UserList")!.kind).toBe("type");

    // Extension function
    expect(symbols.find((s) => s.name === "slugify")!.kind).toBe("function");
    expect(symbols.find((s) => s.name === "slugify")!.signature).toContain("String.");
  });
});
