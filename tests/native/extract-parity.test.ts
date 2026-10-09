// ADR-006 stage 3: the Rust TypeScript/TSX/JavaScript extractor must produce exactly what
// web-tree-sitter + src/parser/extractors/typescript*.ts produce — same symbols, same order, same keys
// in the same order. Real-code parity is checked by scripts/native-extract-parity.ts (0 differences on
// 3.39M symbols); this file pins the handlers one by one so a regression names its construct.
//
// Runs only when the native core is loaded; tests/native/loader.test.ts fails a run that required one.
import { beforeAll, describe, expect, it } from "vitest";
import { initParser, parseFile } from "../../src/parser/parser-manager.js";
import { extractSymbols } from "../../src/parser/symbol-extractor.js";
import { getNativeCore } from "../../src/native/index.js";

const native = (() => {
  try {
    return getNativeCore("parser");
  } catch {
    return null;
  }
})();

const CASES: Array<[string, string, string]> = [
  ["classes", "a.ts", `
/** A base. */
@Injectable()
export abstract class Base<T> extends Parent<T> implements IThing, Other.Iface {
  @Input() readonly name: string = "x";
  private static count = 0;
  #secret = 1;
  static { init(); }
  constructor(private readonly svc: Svc) { super(); }
  abstract run(x: number): Promise<void>;
  get value(): number { return 1; }
  set value(v: number) {}
  protected async load<T>(id: string): Promise<T> { return null as T; }
  override toString(): string { return ""; }
}
const Anon = class extends React.PureComponent { render() { return null; } };
`],
  ["functions and overloads", "b.ts", `
// leading line comment
export function over(a: string): string;
export function over(a: number): number;
export function over(a: any): any { return a; }
export async function* gen() { yield 1; }
declare function ambient(x: number): void;
declare function ambient(x: string): void;
function outer() { function inner() {} const arrow = () => 1; }
`],
  ["variables, constants, object methods", "c.ts", `
export const MAX_RETRIES = 3, other = 4;
let mutable = 1;
const API_URL = "x";
const handlers = {
  onClick() {},
  'on-hover': () => 1,
  useThing: function () {},
  Render: () => <div />,
  plain: 5,
};
export const fetchUser = async (id: string): Promise<User> => api.get(id);
`],
  ["react", "d.tsx", `
export function Button({ label }: Props) { return <button>{label}</button>; }
export const Card = memo(function Card() { return (<div />); });
export const Lazy = lazy(() => import('./x'));
const Fwd = React.forwardRef((props, ref) => <input ref={ref} />);
export function useCounter() { const [n, set] = useState(0); return n; }
function NotAComponent() { return 1; }
export default function () { return <><span /></>; }
`],
  ["modules and exports", "e.ts", `
export namespace Outer { export const inner = 1; namespace Deep { function f() {} } }
declare module 'some-lib' { export function libFn(): void; }
declare global { interface Window { x: number } }
export { a, b as c } from './x';
export * as ns from './y';
const local = 1; function helper() {}
export { local, helper };
export type Alias<T> = T | null;
export interface Shape { area(): number }
export enum Color { Red, Green = 'g', Blue = 4 }
export default class {}
`],
  ["commonjs", "f.js", `
function helper() {}
const VALUE = 1;
module.exports = { helper, run: () => 1, other: VALUE, 'quoted': function () {} };
exports.single = function single(a, b) {};
exports.MAX = 10;
module.exports.Klass = class {};
module.exports = async () => {};
`],
  ["tests", "g.test.ts", `
describe('suite', () => {
  beforeEach(() => {});
  afterAll(async () => {});
  it('works', () => {});
  it.skip('skipped', () => {});
  test.each([1, 2])('each %s', (n) => {});
  describe.only(\`nested \${x}\`, function () { it('deep', () => {}); });
  describe('', () => {});
});
it(name, () => {});
`],
  ["unicode and surrogates", "h.ts", `
const s = '🚀 zażółć 中文';
/** Résumé — naïve. */
export function café(ü: string) { return ü; }
`],
  ["a body longer than 5000 units with a pair at the cut", "i.ts", `
export function long() {
  const x = "${"a".repeat(4980)}🚀🚀🚀 tail";
}
export class Big { ${Array.from({ length: 400 }, (_, i) => `m${i}(a: number): void { return; }`).join("\n  ")} }
`],
  ["syntax errors and async in an ERROR node", "j.ts", `
export async function ok() {}
const broken = async (x: number => { ;
class { method( }
function after() {}
`],
  ["empty file", "k.ts", ""],
  ["python: classes, decorators, __all__, fields", "m.py", `
"""Module doc."""
__all__ = ['a', "b", r'''c''', BASE]
__all__ = BASE + ["x", 'y']
MAX_SIZE = 10
lower = 1

@dataclass(frozen=True)
class Point(Base, metaclass=ABCMeta):
    """A point."""
    x: int = 0
    y = 1

    @property
    def norm(self) -> float:
        return 0.0

    @norm.setter
    @abstractmethod
    async def norm(self, v): ...

    def __init__(self):
        def inner():
            class Deep: pass

class TestThing(unittest.TestCase):
    def test_it(self): pass

@pytest.fixture
def client(): ...

@app.route('/x')
def view():
    def nested(): pass
`],
  ["go: types, fields, methods, package vars", "n.go", `
package store

// Store keeps things.
// It is safe for concurrent use.
type Store struct {
	// mu guards m
	mu sync.Mutex
	a, b int
}

type Reader interface{ Read(p []byte) (int, error) }
type ID string

func New() *Store { return &Store{} }

// Get returns a value.
func (s *Store) Get(ctx context.Context, k string) (v string, ok bool) { return }

const (
	A = iota
	B
)
var global = 1
`],
  ["rust: items, impls, traits, modules", "o.rs", `
/// A point.
/// With two doc lines.
#[derive(Debug)]
pub struct Point { pub x: i32, y: i32 }

impl Point {
    pub fn new(x: i32) -> Self { fn helper() {} Point { x, y: 0 } }
}
impl<T> Wrap<T> { fn get(&self) -> &T { &self.0 } }
impl Display for Point { fn fmt(&self, f: &mut Formatter) -> Result { Ok(()) } }

pub trait Shape { fn area(&self) -> f64; fn name(&self) -> &str { "s" } }
pub enum Color { Red, Green }
type Alias = u32;
static COUNT: u32 = 0;
mod inner { pub const LIMIT: u32 = 3; fn private() {} }
`],
  ["php: namespaces, docblock members, promotion, enums, tests", "p.php", `<?php
namespace App\\Models;

use Foo\\Bar;

/**
 * @property int $id
 * @property-read string $name
 * @property-write array $tags
 * @method self find(int $id)
 * @method static findAll()
 */
#[ORM\\Entity(repositoryClass: UserRepo::class)]
abstract class User extends \\Base\\Model implements JsonSerializable, Countable {
    use SoftDeletes, HasRoles;
    const MAX = 10, MIN = 1;
    /** @var string */
    protected static $email, $phone;
    public readonly int $age;
    public function __construct(private readonly ?int $limit = null, public string $label = '') {}
    abstract protected function name(): string;
    final public static function make(): static { return new static(); }
    public function find($id) {}
}
interface Shape extends Countable { public function area(): float; }
trait HasRoles { public function roles() {} }
enum Status: string implements HasLabel { case Active = 'a'; case Off = 'o'; }
function helper(int $x): int { return $x; }
class UserTest extends \\PHPUnit\\Framework\\TestCase {
    protected function setUp(): void {}
    public function testItWorks() {}
    /** @test */
    public function it_works() {}
}
`],
];

describe.skipIf(!native)("native extractor parity with the TypeScript extractor", () => {
  beforeAll(async () => {
    await initParser();
  });

  it.each(CASES)("%s", async (_label, file, source) => {
    const byExt: Record<string, string> = { tsx: "tsx", js: "javascript", py: "python", go: "go", rs: "rust", php: "php" };
    const language = byExt[file.split(".").pop()!] ?? "typescript";
    const tree = await parseFile(`/repo/${file}`, source);
    const ts = tree ? extractSymbols(tree, file, source, "local/t", language) : [];
    const out = await native!.extractSymbols(source, file, "local/t", language, 30_000);
    // Lone surrogates (a 5,000-unit cut through a pair) are stored as U+FFFD on both paths.
    const norm = (s: string) => s.replace(/\\ud[89ab][0-9a-f]{2}/gi, "�");
    expect(norm(JSON.stringify(JSON.parse(out.json)))).toBe(norm(JSON.stringify(ts)));
    expect(out.timedOut).toBe(false);
  });

  it("reports syntax errors the way the TypeScript extractor warns about them", async () => {
    const out = await native!.extractSymbols("class { method( }", "x.ts", "r", "typescript", 30_000);
    expect(out.hasError).toBe(true);
  });

  it("refuses a language it does not extract", async () => {
    await expect(native!.extractSymbols("x := 1", "x.zig", "r", "zig", 30_000)).rejects.toThrow(/no native extractor/);
  });
});
