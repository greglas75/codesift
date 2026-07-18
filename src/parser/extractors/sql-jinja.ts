export function stripJinjaTokens(source: string): string {
  const preserveLines = (match: string) => match.replace(/[^\n]/g, " ");
  return source
    .replace(/\{#[\s\S]*?#\}/g, preserveLines)    // Jinja comments
    .replace(/\{%[\s\S]*?%\}/g, preserveLines)    // Jinja blocks
    .replace(/\{\{[\s\S]*?\}\}/g, preserveLines); // Jinja expressions
}
