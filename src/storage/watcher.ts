import { watch, type FSWatcher } from "chokidar";
import { relative } from "node:path";
import { toIgnorePatterns } from "../utils/walk.js";

export type { FSWatcher };

const IGNORE_PATTERNS = toIgnorePatterns();

// WeakMap to track debounce timers per watcher for cleanup
const watcherTimers = new WeakMap<FSWatcher, Map<string, ReturnType<typeof setTimeout>>>();

/**
 * Start watching a repo root for file changes.
 * Calls onChange with the relative file path, debounced per file at 500ms.
 */
export function startWatcher(
  repoRoot: string,
  onChange: (filePath: string) => void,
): FSWatcher {
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const debouncedOnChange = (absolutePath: string): void => {
    const relativePath = relative(repoRoot, absolutePath);

    const existing = debounceTimers.get(relativePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      debounceTimers.delete(relativePath);
      onChange(relativePath);
    }, 500);

    debounceTimers.set(relativePath, timer);
  };

  const watcher = watch(repoRoot, {
    ignored: IGNORE_PATTERNS,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });

  watcher.on("add", debouncedOnChange);
  watcher.on("change", debouncedOnChange);

  watcherTimers.set(watcher, debounceTimers);

  return watcher;
}

/**
 * Stop a file watcher and clean up all debounce timers.
 */
export async function stopWatcher(watcher: FSWatcher): Promise<void> {
  const timers = watcherTimers.get(watcher);
  if (timers) {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    watcherTimers.delete(watcher);
  }

  await watcher.close();
}
