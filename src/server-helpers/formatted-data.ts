import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The raw result behind a handler's formatted text, for the response shorteners.
 *
 * Every tool with a registered shortener returns `dispatchFormatter(name, result)` — a string — so
 * the shortener used to receive that string and read `.handlers.length` off it: any trace_route,
 * analyze_complexity, find_clones, analyze_hotspots or nextjs/framework audit answer above the
 * compact threshold failed the whole call with "Cannot read properties of undefined (reading
 * 'length')". `wrapTool` opens one slot per call; `dispatchFormatter` fills it.
 */
export interface FormattedDataSlot {
  tool?: string;
  data?: unknown;
}

const store = new AsyncLocalStorage<FormattedDataSlot>();

export function runWithFormattedDataSlot<T>(slot: FormattedDataSlot, fn: () => Promise<T>): Promise<T> {
  return store.run(slot, fn);
}

export function recordFormattedData(tool: string, data: unknown): void {
  const slot = store.getStore();
  if (!slot) return;
  slot.tool = tool;
  slot.data = data;
}
