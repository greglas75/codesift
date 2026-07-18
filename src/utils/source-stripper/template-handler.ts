import { flushIdentifier } from "./state.js";
import { nextChar, type StripContext } from "./types.js";

export function handleTemplate(context: StripContext): void {
  const c = context.source[context.i]!;
  if (c === "\\" && nextChar(context)) {
    context.out.push(" ", " ");
    context.i += 2;
    return;
  }
  if (c === "$" && nextChar(context) === "{") {
    context.templateStack.push({ braceDepth: context.braceDepth + 1 });
    context.braceDepth++;
    context.state = "code";
    context.out.push("$", "{");
    context.i += 2;
    context.lastCodeChar = "{";
    return;
  }
  if (c === "`") {
    context.state = "code";
    context.out.push(" ");
    context.i++;
    return;
  }
  context.out.push(c === "\n" ? "\n" : " ");
  context.i++;
}

export function closeTemplateInterpolation(context: StripContext): boolean {
  if (context.templateStack.length === 0 || context.templateStack[context.templateStack.length - 1]!.braceDepth !== context.braceDepth) return false;
  context.templateStack.pop();
  context.braceDepth--;
  context.state = "template";
  context.out.push(" ");
  context.i++;
  flushIdentifier(context);
  context.lastCodeChar = "";
  return true;
}
