export function estimateTokens(source: string): number {
  return Math.ceil(source.length / 4);
}
