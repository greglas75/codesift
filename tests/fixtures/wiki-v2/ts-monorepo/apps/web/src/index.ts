import { formatName } from "./utils/format.js";
import { Page } from "./page.js";

export function renderApp(): string {
  const name = formatName("world");
  return Page(name);
}
