import { nextChar, type StripContext } from "./types.js";

export function handleString(context: StripContext): void {
  const c = context.source[context.i]!;
  if (c === "\\" && nextChar(context)) {
    context.out.push(" ", " ");
    context.i += 2;
    return;
  }
  const closer = context.state === "single" ? "'" : '"';
  if (c === closer) {
    context.state = "code";
    context.out.push(" ");
    context.i++;
    return;
  }
  context.out.push(c === "\n" ? "\n" : " ");
  context.i++;
}
