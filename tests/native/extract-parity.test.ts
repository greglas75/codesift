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
];

describe.skipIf(!native)("native extractor parity with the TypeScript extractor", () => {
  beforeAll(async () => {
    await initParser();
  });

  it.each(CASES)("%s", async (_label, file, source) => {
    const language = file.endsWith(".tsx") ? "tsx" : file.endsWith(".js") ? "javascript" : "typescript";
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
    await expect(native!.extractSymbols("x = 1", "x.py", "r", "python", 30_000)).rejects.toThrow(/no native extractor/);
  });
});
