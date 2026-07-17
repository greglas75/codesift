export function createOffsetToLine(source: string): (offset: number) => number {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const start = starts[middle];
      if (start !== undefined && start <= offset) {
        if (middle === starts.length - 1 || (starts[middle + 1] ?? Infinity) > offset) return middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return 0;
  };
}
