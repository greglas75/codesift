export function literalChangedFilePattern(changedFiles: string[]): string {
  if (changedFiles.length === 1) {
    return changedFiles[0]!.replace(/[\\*?\[\]{}(),!+@]/g, "\\$&");
  }

  return `{${changedFiles
    .map((filePath) => filePath.replace(/[\\*?\[\]{}(),!+@]/g, "\\$&"))
    .join(",")}}`;
}
