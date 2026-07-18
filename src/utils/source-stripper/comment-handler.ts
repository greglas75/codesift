import { nextChar, type StripContext } from "./types.js";

export function handleLineComment(context: StripContext): void {
  const c = context.source[context.i]!;
  if (c === "\n") {
    context.state = "code";
    context.out.push("\n");
  } else {
    context.out.push(" ");
  }
  context.i++;
}

export function handleBlockComment(context: StripContext): void {
  const c = context.source[context.i]!;
  if (c === "*" && nextChar(context) === "/") {
    context.state = "code";
    context.out.push(" ", " ");
    context.i += 2;
    return;
  }
  context.out.push(c === "\n" ? "\n" : " ");
  context.i++;
}
