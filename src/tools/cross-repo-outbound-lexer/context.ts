import type { LexerState } from "./types.js";

export class LexerContext {
  readonly out: string[] = [];
  readonly templateStack: number[] = [];
  index = 0;
  state: LexerState = "code";
  line = 1;
  braceDepth = 0;
  inRegexClass = false;

  constructor(readonly source: string) {}

  get length(): number {
    return this.source.length;
  }

  current(): string {
    return this.source[this.index] ?? "";
  }

  peek(offset = 1): string {
    return this.source[this.index + offset] ?? "";
  }

  emit(value = this.current()): void {
    this.out.push(value);
    this.index++;
  }

  skipWhitespace(start = this.index): number {
    let position = start;
    while (position < this.length && /[ \t\n\r]/.test(this.source[position]!)) position++;
    return position;
  }
}
