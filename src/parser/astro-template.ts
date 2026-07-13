/** Shared pure parser for the HTML template section of `.astro` files. */
import { prepareTemplate } from "./astro-template/preprocess.js";
import { scanTemplate } from "./astro-template/scanner.js";
import type { AstroTemplateParse } from "./astro-template/types.js";

export type { AstroTemplateParse, Island, Slot, ComponentUsage, Directive } from "./astro-template/types.js";

export function parseAstroTemplate(source: string, frontmatterImports?: Map<string, string>): AstroTemplateParse {
  const prepared = prepareTemplate(source);
  if (prepared.kind === "result") return prepared.result;
  return scanTemplate(prepared.template, prepared.startLine, frontmatterImports);
}
