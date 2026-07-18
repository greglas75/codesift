import { handleCode } from "./code-handler.js";
import { handleBlockComment, handleLineComment } from "./comment-handler.js";
import { handleRegex } from "./regex-handler.js";
import { createContext } from "./state.js";
import { handleString } from "./string-handler.js";
import { handleTemplate } from "./template-handler.js";

export function runStripMachine(source: string): string {
  const context = createContext(source);
  while (context.i < source.length) {
    switch (context.state) {
      case "code": handleCode(context); break;
      case "lineComment": handleLineComment(context); break;
      case "blockComment": handleBlockComment(context); break;
      case "regex": handleRegex(context); break;
      case "single":
      case "double": handleString(context); break;
      case "template": handleTemplate(context); break;
    }
  }
  return context.out.join("");
}
