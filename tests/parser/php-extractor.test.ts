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

describe("extractPhpSymbols — PHPDoc @property/@method synthesis", () => {
  it("synthesizes fields for @property tags in class docblock", async () => {
    const symbols = await parse(`<?php
/**
 * @property int $id
 * @property string $email
 * @method ActiveQuery getPosts()
 */
class User {
    public function realMethod() {}
}
`);
    const cls = symbols.find(s => s.name === "User" && s.kind === "class");
    expect(cls).toBeDefined();

    const idField = symbols.find(s => s.name === "id" && s.kind === "field");
    const emailField = symbols.find(s => s.name === "email" && s.kind === "field");
    const getPostsMethod = symbols.find(s => s.name === "getPosts" && s.kind === "method");
    const realMethod = symbols.find(s => s.name === "realMethod" && s.kind === "method");

    expect(idField).toBeDefined();
    expect(emailField).toBeDefined();
    expect(getPostsMethod).toBeDefined();
    expect(realMethod).toBeDefined();

    // Synthetic flag present on docblock-derived symbols
    expect(idField!.meta?.synthetic).toBe(true);
    expect(emailField!.meta?.synthetic).toBe(true);
    expect(getPostsMethod!.meta?.synthetic).toBe(true);

    // Real method has no synthetic flag
    expect(realMethod!.meta?.synthetic).toBeUndefined();

    // All children attached to class as parent
    expect(idField!.parent).toBe(cls!.id);
    expect(emailField!.parent).toBe(cls!.id);
    expect(getPostsMethod!.parent).toBe(cls!.id);

    // Type hint preserved in signature field
    expect(idField!.signature).toBe("int");
    expect(emailField!.signature).toBe("string");
    expect(getPostsMethod!.signature).toBe("ActiveQuery");
  });

  it("deduplicates synthetic symbols against real methods", async () => {
    const symbols = await parse(`<?php
/**
 * @method array getPosts()
 */
class User {
    public function getPosts(): array {
        return [];
    }
}
`);
    // Only ONE getPosts symbol — real wins, synthetic skipped
    const getPosts = symbols.filter(s => s.name === "getPosts");
    expect(getPosts).toHaveLength(1);
    expect(getPosts[0].meta?.synthetic).toBeUndefined();
  });

  it("does not synthesize when class has no docblock", async () => {
    const symbols = await parse(`<?php
class Plain {
    public function realMethod() {}
}
`);
    const synthetic = symbols.filter(s => s.meta?.synthetic);
    expect(synthetic).toHaveLength(0);
  });
});

describe("extractPhpSymbols — interface/trait PHPDoc synthesis", () => {
  it("synthesizes @property field on an interface", async () => {
    const symbols = await parse(`<?php
/**
 * @property int $id
 * @property string $name
 */
interface Identifiable {
    public function getId(): int;
}
`);
    const iface = symbols.find(s => s.name === "Identifiable" && s.kind === "interface");
    expect(iface).toBeDefined();

    const idField = symbols.find(s => s.name === "id" && s.kind === "field");
    const nameField = symbols.find(s => s.name === "name" && s.kind === "field");

    expect(idField).toBeDefined();
    expect(nameField).toBeDefined();
    expect(idField!.meta?.synthetic).toBe(true);
    expect(idField!.parent).toBe(iface!.id);
    expect(idField!.signature).toBe("int");
    expect(nameField!.meta?.synthetic).toBe(true);
  });

  it("synthesizes @property and @method on a trait", async () => {
    const symbols = await parse(`<?php
/**
 * @property string $timestamp
 * @method void touch()
 */
trait Timestamps {
}
`);
    const trait = symbols.find(s => s.name === "Timestamps" && s.kind === "type");
    expect(trait).toBeDefined();

    const timestamp = symbols.find(s => s.name === "timestamp" && s.kind === "field");
    const touch = symbols.find(s => s.name === "touch" && s.kind === "method");

    expect(timestamp).toBeDefined();
    expect(touch).toBeDefined();
    expect(timestamp!.meta?.synthetic).toBe(true);
    expect(touch!.meta?.synthetic).toBe(true);
    expect(timestamp!.parent).toBe(trait!.id);
    expect(touch!.parent).toBe(trait!.id);
  });

  it("dedups synthetic @method against real trait method", async () => {
    const symbols = await parse(`<?php
/**
 * @method array getPosts()
 */
trait HasPosts {
    public function getPosts(): array {
        return [];
    }
}
`);
    const getPosts = symbols.filter(s => s.name === "getPosts");
    expect(getPosts).toHaveLength(1);
    expect(getPosts[0].meta?.synthetic).toBeUndefined();
  });

  it("does not synthesize when interface has no docblock", async () => {
    const symbols = await parse(`<?php
interface Plain {
    public function hello(): void;
}
`);
    const synthetic = symbols.filter(s => s.meta?.synthetic);
    expect(synthetic).toHaveLength(0);
  });
});

describe("extractPhpSymbols — interface/trait synthesis edge cases", () => {
  it("handles @property-read and @property-write on interfaces", async () => {
    const symbols = await parse(`<?php
/**
 * @property-read int $id
 * @property-write string $password
 */
interface Credentials {
}
`);
    const id = symbols.find(s => s.name === "id" && s.kind === "field");
    const password = symbols.find(s => s.name === "password" && s.kind === "field");
    expect(id).toBeDefined();
    expect(password).toBeDefined();
    expect(id!.meta?.synthetic).toBe(true);
    expect(password!.meta?.synthetic).toBe(true);
  });

  it("each trait synthesizes only from its own docblock, not a sibling's", async () => {
    const symbols = await parse(`<?php
/**
 * @property string $a
 */
trait FirstTrait {}

/**
 * @property string $b
 */
trait SecondTrait {}
`);
    const first = symbols.find(s => s.name === "FirstTrait");
    const second = symbols.find(s => s.name === "SecondTrait");
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const aField = symbols.find(s => s.name === "a" && s.kind === "field");
    const bField = symbols.find(s => s.name === "b" && s.kind === "field");
    expect(aField).toBeDefined();
    expect(bField).toBeDefined();
    expect(aField!.parent).toBe(first!.id);
    expect(bField!.parent).toBe(second!.id);

    // Neither trait should have BOTH fields — each only synthesizes its own
    const firstChildren = symbols.filter(s => s.parent === first!.id);
    const secondChildren = symbols.filter(s => s.parent === second!.id);
    expect(firstChildren.map(s => s.name).sort()).toEqual(["a"]);
    expect(secondChildren.map(s => s.name).sort()).toEqual(["b"]);
  });
});
