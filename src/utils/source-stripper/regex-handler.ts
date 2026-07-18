import { nextChar, type StripContext } from "./types.js";

export function handleRegex(context: StripContext): void {
  const c = context.source[context.i]!;
  if (c === "\\" && nextChar(context)) {
    context.out.push(" ", " ");
    context.i += 2;
    return;
  }
  if (c === "[") {
    consumeCharacterClass(context);
    return;
  }
  if (c === "/") {
    context.out.push(" ");
    context.i++;
    while (context.i < context.source.length && /[gimsuydv]/.test(context.source[context.i]!)) {
      context.out.push(" ");
      context.i++;
    }
    context.state = "code";
    context.lastCodeChar = "/";
    return;
  }
  context.out.push(c === "\n" ? "\n" : " ");
  context.i++;
}

function consumeCharacterClass(context: StripContext): void {
  context.out.push(" ");
  context.i++;
  while (context.i < context.source.length && context.source[context.i] !== "]") {
    if (context.source[context.i] === "\\" && context.i + 1 < context.source.length) {
      context.out.push(" ", " ");
      context.i += 2;
      continue;
    }
    context.out.push(context.source[context.i] === "\n" ? "\n" : " ");
    context.i++;
  }
  if (context.i < context.source.length) {
    context.out.push(" ");
    context.i++;
  }
}
