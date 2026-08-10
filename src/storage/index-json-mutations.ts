import type { CodeIndex, CodeSymbol, FileEntry } from "../types.js";

type MutationIo = {
  loadIndex: (indexPath: string) => Promise<CodeIndex | null>;
  saveIndex: (indexPath: string, index: CodeIndex) => Promise<void>;
};

interface IndexMutation {
  apply: (index: CodeIndex) => boolean;
  missing: "throw" | "skip";
  resolve: () => void;
  reject: (err: unknown) => void;
}

const writeLocks = new Map<string, Promise<void>>();
const pendingMutations = new Map<string, IndexMutation[]>();
const scheduledFlushes = new Map<string, Promise<void>>();

let indexWriteCount = 0;

export function getIndexWriteCountForTesting(): number {
  return indexWriteCount;
}

export function resetIndexWriteCountForTesting(): void {
  indexWriteCount = 0;
}

/** Fold every queued mutation for one JSON index into a single load and save. */
async function flushIndexMutations(indexPath: string, io: MutationIo): Promise<void> {
  const batch = pendingMutations.get(indexPath);
  if (!batch || batch.length === 0) return;
  pendingMutations.delete(indexPath);

  try {
    const existing = await io.loadIndex(indexPath);
    if (!existing) {
      for (const mutation of batch) {
        if (mutation.missing === "throw") {
          mutation.reject(new Error(`Cannot incrementally update: index not found at ${indexPath}`));
        } else {
          mutation.resolve();
        }
      }
      return;
    }

    let changed = false;
    for (const mutation of batch) {
      if (mutation.apply(existing)) changed = true;
    }
    if (changed) {
      existing.updated_at = Date.now();
      indexWriteCount++;
      await io.saveIndex(indexPath, existing);
    }
    for (const mutation of batch) mutation.resolve();
  } catch (err) {
    for (const mutation of batch) mutation.reject(err);
  }
}

function enqueueIndexMutation(
  indexPath: string,
  missing: IndexMutation["missing"],
  apply: (index: CodeIndex) => boolean,
  io: MutationIo,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const queue = pendingMutations.get(indexPath);
    if (queue) queue.push({ apply, missing, resolve, reject });
    else pendingMutations.set(indexPath, [{ apply, missing, resolve, reject }]);

    if (scheduledFlushes.has(indexPath)) return;

    const previous = writeLocks.get(indexPath) ?? Promise.resolve();
    const next = previous.then(() => {
      scheduledFlushes.delete(indexPath);
      return flushIndexMutations(indexPath, io);
    });
    scheduledFlushes.set(indexPath, next);
    writeLocks.set(indexPath, next.catch(() => {}));
  });
}

export function saveIncrementalJson(
  indexPath: string,
  updatedFile: string,
  newSymbols: CodeSymbol[],
  fileEntry: FileEntry | undefined,
  io: MutationIo,
): Promise<void> {
  return enqueueIndexMutation(
    indexPath,
    "throw",
    (existing) => {
      const filtered = existing.symbols.filter((symbol) => symbol.file !== updatedFile);
      const merged = [...filtered, ...newSymbols];

      existing.symbols = merged;
      existing.symbol_count = merged.length;
      if (fileEntry) {
        existing.files = existing.files.filter((file) => file.path !== updatedFile);
        existing.files.push(fileEntry);
        existing.file_count = existing.files.length;
      }
      return true;
    },
    io,
  );
}

export function removeFileFromJsonIndex(
  indexPath: string,
  deletedFile: string,
  io: MutationIo,
): Promise<void> {
  return enqueueIndexMutation(
    indexPath,
    "skip",
    (existing) => {
      const hadSymbols = existing.symbols.some((symbol) => symbol.file === deletedFile);
      const hadFile = existing.files.some((file) => file.path === deletedFile);
      if (!hadSymbols && !hadFile) return false;

      existing.symbols = existing.symbols.filter((symbol) => symbol.file !== deletedFile);
      existing.symbol_count = existing.symbols.length;
      existing.files = existing.files.filter((file) => file.path !== deletedFile);
      existing.file_count = existing.files.length;
      return true;
    },
    io,
  );
}
