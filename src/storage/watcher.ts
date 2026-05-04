/**
 * File watcher built on @parcel/watcher.
 *
 * Why not chokidar:
 *   - chokidar 4.x dropped fsevents support entirely. On macOS that pushed
 *     the watcher onto Node's fs.watch fallback, which on this platform
 *     allocates one fd per directory. Indexing several CMS-style repos
 *     (~1000+ subdirs each) drove the system file table to ENFILE.
 *   - chokidar 3.x is a workaround (deps rollback, locks us out of upstream
 *     fixes) — not a real solution.
 *
 * @parcel/watcher uses native, recursive backends:
 *   macOS  → FSEvents (1 stream per recursive root, fd-cheap)
 *   Linux  → inotify  (1 watcher per root)
 *   Win    → ReadDirectoryChangesW (1 handle per root)
 *
 * The exported API (`startWatcher`, `stopWatcher`, `FSWatcher`) keeps the
 * same shape callers already use — only `startWatcher` is now async because
 * `parcelWatcher.subscribe()` returns a Promise.
 */
import * as parcelWatcher from "@parcel/watcher";
import { relative, join } from "node:path";
import { IGNORE_DIRS } from "../utils/walk.js";

/**
 * Re-exported under the historical name so call sites keep working unchanged.
 * Underneath this is a `parcelWatcher.AsyncSubscription`.
 */
export type FSWatcher = parcelWatcher.AsyncSubscription;

const watcherTimers = new WeakMap<
  parcelWatcher.AsyncSubscription,
  Map<string, ReturnType<typeof setTimeout>>
>();

/**
 * Build the ignore list for @parcel/watcher. The library accepts absolute
 * paths and glob patterns. We feed it both:
 *  - Absolute paths to known top-level vendor dirs (cheapest: native skip
 *    of subtree traversal at the root).
 *  - Globs for nested occurrences (`**\/node_modules` style) — handles the
 *    common case where vendored deps live under a workspace.
 */
function buildIgnoreList(repoRoot: string): string[] {
  const ignores: string[] = [];
  for (const dir of IGNORE_DIRS) {
    ignores.push(join(repoRoot, dir));
    ignores.push(`**/${dir}`);
    ignores.push(`**/${dir}/**`);
  }
  return ignores;
}

/**
 * Subscribe to file changes under `repoRoot`. Calls `onChange` with the
 * relative file path on create/update events (debounced 500ms per file)
 * and `onDelete` immediately on delete events.
 *
 * Returns the underlying subscription so the caller can later pass it to
 * `stopWatcher`.
 */
export async function startWatcher(
  repoRoot: string,
  onChange: (filePath: string) => void,
  onDelete?: (filePath: string) => void,
): Promise<FSWatcher> {
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

  const subscription = await parcelWatcher.subscribe(
    repoRoot,
    (err, events) => {
      if (err) {
        console.error(
          `[parcel-watcher] error watching ${repoRoot}: ${err.message}`,
        );
        return;
      }
      for (const event of events) {
        if (event.type === "delete") {
          const relativePath = relative(repoRoot, event.path);
          // Cancel any pending change debounce — a delete supersedes it
          const pendingTimer = debounceTimers.get(relativePath);
          if (pendingTimer !== undefined) {
            clearTimeout(pendingTimer);
            debounceTimers.delete(relativePath);
          }
          if (onDelete) onDelete(relativePath);
        } else {
          // 'create' or 'update' — both go through the debounced path so
          // editors performing atomic-write-then-rename only fire once.
          debouncedOnChange(event.path);
        }
      }
    },
    { ignore: buildIgnoreList(repoRoot) },
  );

  watcherTimers.set(subscription, debounceTimers);
  return subscription;
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

  await watcher.unsubscribe();
}
