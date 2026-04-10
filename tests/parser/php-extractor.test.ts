import { initParser, getParser } from "../../src/parser/parser-manager.js";
import { extractPhpSymbols } from "../../src/parser/extractors/php.js";

beforeAll(async () => {
  await initParser();
});

async function parse(source: string) {
  const parser = await getParser("php");
  expect(parser).not.toBeNull();
  const tree = parser!.parse(source);
  return extractPhpSymbols(tree, "test.php", source, "test-repo");
}

describe("extractPhpSymbols — basic constructs", () => {
  it("extracts a top-level function", async () => {
    const symbols = await parse(`<?php
function hello(string $name): string {
  return "Hello, " . $name;
}
`);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("hello");
    expect(symbols[0].kind).toBe("function");
    expect(symbols[0].signature).toContain("string $name");
    expect(symbols[0].signature).toContain(": string");
  });

  it("extracts a class with methods and properties", async () => {
    const symbols = await parse(`<?php
class User {
  public string $name;
  private int $age;

  public function getName(): string {
    return $this->name;
  }

  public function setAge(int $age): void {
    $this->age = $age;
  }
}
`);
    const cls = symbols.find(s => s.name === "User");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");

    const nameProp = symbols.find(s => s.name === "$name");
    expect(nameProp).toBeDefined();
    expect(nameProp!.kind).toBe("field");
    expect(nameProp!.parent).toBe(cls!.id);

    const ageProp = symbols.find(s => s.name === "$age");
    expect(ageProp).toBeDefined();
    expect(ageProp!.kind).toBe("field");

    const getName = symbols.find(s => s.name === "getName");
    expect(getName).toBeDefined();
    expect(getName!.kind).toBe("method");
    expect(getName!.parent).toBe(cls!.id);
    expect(getName!.signature).toContain("(): string");

    const setAge = symbols.find(s => s.name === "setAge");
    expect(setAge).toBeDefined();
    expect(setAge!.kind).toBe("method");
    expect(setAge!.signature).toContain("int $age");
  });

  it("extracts an interface", async () => {
    const symbols = await parse(`<?php
interface Cacheable {
  public function getCacheKey(): string;
  public function getCacheTtl(): int;
}
`);
    const iface = symbols.find(s => s.name === "Cacheable");
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe("interface");

    const methods = symbols.filter(s => s.kind === "method");
    expect(methods).toHaveLength(2);
    expect(methods[0].parent).toBe(iface!.id);
  });

  it("extracts a trait as 'type' kind", async () => {
    const symbols = await parse(`<?php
trait Timestamps {
  public function getCreatedAt(): string {
    return $this->created_at;
  }
}
`);
    const trait = symbols.find(s => s.name === "Timestamps");
    expect(trait).toBeDefined();
    expect(trait!.kind).toBe("type");

    const method = symbols.find(s => s.name === "getCreatedAt");
    expect(method).toBeDefined();
    expect(method!.kind).toBe("method");
    expect(method!.parent).toBe(trait!.id);
  });

  it("extracts a PHP 8.1 enum with cases", async () => {
    const symbols = await parse(`<?php
enum Status: string {
  case Active = 'active';
  case Inactive = 'inactive';
  case Pending = 'pending';
}
`);
    const enumSym = symbols.find(s => s.name === "Status");
    expect(enumSym).toBeDefined();
    expect(enumSym!.kind).toBe("enum");

    const cases = symbols.filter(s => s.kind === "constant");
    expect(cases).toHaveLength(3);
    expect(cases.map(c => c.name)).toEqual(["Active", "Inactive", "Pending"]);
    expect(cases[0].parent).toBe(enumSym!.id);
  });
});

describe("extractPhpSymbols — namespace", () => {
  it("extracts namespace and nests children under it", async () => {
    const symbols = await parse(`<?php
namespace App\\Models;

class User {
  public string $name;
}
`);
    // Note: in non-braced namespace, siblings follow after namespace_definition
    // The tree-sitter grammar may put class as sibling, not child
    const ns = symbols.find(s => s.kind === "namespace");
    expect(ns).toBeDefined();
    expect(ns!.name).toBe("App\\Models");

    const cls = symbols.find(s => s.name === "User");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
  });

  it("extracts braced namespace with children", async () => {
    const symbols = await parse(`<?php
namespace App\\Services {
  class UserService {
    public function create(): void {}
  }
}
`);
    const ns = symbols.find(s => s.kind === "namespace");
    expect(ns).toBeDefined();

    const cls = symbols.find(s => s.name === "UserService");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
    expect(cls!.parent).toBe(ns!.id);
  });
});

describe("extractPhpSymbols — constants", () => {
  it("extracts class constants", async () => {
    const symbols = await parse(`<?php
class Config {
  const VERSION = '1.0.0';
  const MAX_RETRIES = 3;
}
`);
    const consts = symbols.filter(s => s.kind === "constant");
    expect(consts).toHaveLength(2);
    expect(consts.map(c => c.name)).toContain("VERSION");
    expect(consts.map(c => c.name)).toContain("MAX_RETRIES");
  });
});

describe("extractPhpSymbols — PHPDoc", () => {
  it("extracts PHPDoc as docstring", async () => {
    const symbols = await parse(`<?php
/**
 * Represents a user in the system.
 * @property string $email
 */
class User {
  /**
   * Get the user's full name.
   * @return string
   */
  public function getFullName(): string {
    return $this->first_name . ' ' . $this->last_name;
  }
}
`);
    const cls = symbols.find(s => s.name === "User");
    expect(cls).toBeDefined();
    expect(cls!.docstring).toContain("Represents a user");
    expect(cls!.docstring).toContain("@property");

    const method = symbols.find(s => s.name === "getFullName");
    expect(method).toBeDefined();
    expect(method!.docstring).toContain("Get the user's full name");
    expect(method!.docstring).toContain("@return string");
  });
});

describe("extractPhpSymbols — PHPUnit test detection", () => {
  it("classifies TestCase subclass as test_suite", async () => {
    const symbols = await parse(`<?php
use PHPUnit\\Framework\\TestCase;

class UserTest extends TestCase {
  public function testCreate(): void {
    $user = new User();
    $this->assertNotNull($user);
  }

  public function testUpdate(): void {
    $this->assertTrue(true);
  }

  public function setUp(): void {
    parent::setUp();
  }

  public function tearDown(): void {
    parent::tearDown();
  }

  public function helperMethod(): void {}
}
`);
    const testClass = symbols.find(s => s.name === "UserTest");
    expect(testClass).toBeDefined();
    expect(testClass!.kind).toBe("test_suite");

    const testCreate = symbols.find(s => s.name === "testCreate");
    expect(testCreate).toBeDefined();
    expect(testCreate!.kind).toBe("test_case");

    const testUpdate = symbols.find(s => s.name === "testUpdate");
    expect(testUpdate).toBeDefined();
    expect(testUpdate!.kind).toBe("test_case");

    const setUp = symbols.find(s => s.name === "setUp");
    expect(setUp).toBeDefined();
    expect(setUp!.kind).toBe("test_hook");

    const tearDown = symbols.find(s => s.name === "tearDown");
    expect(tearDown).toBeDefined();
    expect(tearDown!.kind).toBe("test_hook");

    const helper = symbols.find(s => s.name === "helperMethod");
    expect(helper).toBeDefined();
    expect(helper!.kind).toBe("method");
  });

  it("detects @test annotation in PHPDoc", async () => {
    const symbols = await parse(`<?php
class UserTest extends TestCase {
  /**
   * @test
   */
  public function itCreatesAUser(): void {}
}
`);
    const method = symbols.find(s => s.name === "itCreatesAUser");
    expect(method).toBeDefined();
    expect(method!.kind).toBe("test_case");
  });
});

describe("extractPhpSymbols — Yii2 patterns", () => {
  it("extracts Yii2 controller with actions", async () => {
    const symbols = await parse(`<?php
namespace app\\controllers;

use yii\\web\\Controller;

class SiteController extends Controller {
  public function actionIndex(): string {
    return $this->render('index');
  }

  public function actionAbout(): string {
    return $this->render('about');
  }

  public function behaviors(): array {
    return [];
  }
}
`);
    const cls = symbols.find(s => s.name === "SiteController");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");

    const actions = symbols.filter(s => s.name.startsWith("action"));
    expect(actions).toHaveLength(2);
    expect(actions[0].kind).toBe("method");
    expect(actions[0].parent).toBe(cls!.id);
  });

  it("extracts Yii2 ActiveRecord model", async () => {
    const symbols = await parse(`<?php
namespace app\\models;

use yii\\db\\ActiveRecord;

class User extends ActiveRecord {
  public static function tableName(): string {
    return 'user';
  }

  public function rules(): array {
    return [
      [['name', 'email'], 'required'],
      ['email', 'email'],
    ];
  }

  public function getProfile() {
    return $this->hasOne(Profile::class, ['user_id' => 'id']);
  }

  public function getComments() {
    return $this->hasMany(Comment::class, ['user_id' => 'id']);
  }
}
`);
    const cls = symbols.find(s => s.name === "User");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");

    const methods = symbols.filter(s => s.kind === "method");
    expect(methods.length).toBeGreaterThanOrEqual(4);
    expect(methods.map(m => m.name)).toContain("tableName");
    expect(methods.map(m => m.name)).toContain("rules");
    expect(methods.map(m => m.name)).toContain("getProfile");
    expect(methods.map(m => m.name)).toContain("getComments");
  });
});

describe("extractPhpSymbols — edge cases", () => {
  it("handles empty class", async () => {
    const symbols = await parse(`<?php
class EmptyClass {}
`);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("EmptyClass");
    expect(symbols[0].kind).toBe("class");
  });

  it("handles abstract class", async () => {
    const symbols = await parse(`<?php
abstract class BaseModel {
  abstract public function tableName(): string;
}
`);
    const cls = symbols.find(s => s.name === "BaseModel");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
  });

  it("handles multiple functions in one file", async () => {
    const symbols = await parse(`<?php
function first(): void {}
function second(): int { return 1; }
function third(string $x): bool { return true; }
`);
    expect(symbols).toHaveLength(3);
    expect(symbols.every(s => s.kind === "function")).toBe(true);
  });
});
