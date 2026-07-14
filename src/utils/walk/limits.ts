const DEFAULT_MAX_FILE_SIZE = 1_000_000;

export class WalkLimits {
  readonly maxFileSize: number;
  private readonly maxFiles: number;
  private count = 0;
  private limitReached = false;

  constructor(maxFileSize?: number, maxFiles?: number) {
    this.maxFileSize = maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.maxFiles = maxFiles ?? Infinity;
  }

  get canContinue(): boolean {
    return !this.limitReached;
  }

  acceptFile(): void {
    this.count += 1;
    if (this.count >= this.maxFiles) {
      console.warn(
        `[codesift] walkDirectory: reached ${this.maxFiles} file limit, returning partial results`,
      );
      this.limitReached = true;
    }
  }
}
