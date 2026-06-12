// Streaming pump + integrity logic for HuggingFace Hub downloads.
// Extracted from hf-hub-download.ts — pure move, behavior identical.

import { createWriteStream, WriteStream } from "node:fs";

/** Destroy a WriteStream and wait for 'close' so the fd is released before callers unlink. */
export function destroyAndWait(ws: WriteStream): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ws.closed) { resolve(); return; }
    ws.once("close", resolve);
    ws.destroy();
  });
}

/** FIX-2: default per-chunk inactivity timeout (overridable via opts for tests). */
export const READ_INACTIVITY_MS = 30_000;

/** FIX-B: how many consecutive zero-byte chunks before the download is declared stalled. */
export const MAX_ZERO_READS = 1000;

export interface PumpOpts {
  maxBytes: number;
  expectedLength: number | null;
  /** URL string used only in error messages. */
  url: string;
  /** FIX-2: max ms of silence between chunks before the download is declared stalled. */
  inactivityMs?: number;
}

/**
 * Stream `body` to `tmpPath`, enforcing the byte cap and verifying content-length.
 * Resolves with the number of bytes written; caller handles rename / unlink.
 */
export async function pumpToFile(
  body: ReadableStream<Uint8Array>,
  tmpPath: string,
  opts: PumpOpts,
): Promise<number> {
  const { maxBytes, expectedLength, url } = opts;
  const inactivityMs = opts.inactivityMs ?? READ_INACTIVITY_MS;
  const ws = createWriteStream(tmpPath);

  // Capture WriteStream errors into the promise flow immediately
  let wsError: Error | undefined;
  const wsErrorPromise = new Promise<never>((_resolve, reject) => {
    ws.on("error", (err: Error) => {
      wsError = err;
      reject(err);
    });
  });

  let accumulated = 0;
  let zeroReads = 0;
  const reader = body.getReader();

  try {
    while (true) {
      // FIX-2: race each chunk read against a per-chunk inactivity timer
      let inactivityHandle: ReturnType<typeof setTimeout> | undefined;
      const inactivityTimer = new Promise<never>((_resolve, reject) => {
        inactivityHandle = setTimeout(
          () => reject(new Error(`ensureModelFile: download stalled: no data for ${inactivityMs}ms from ${url}`)),
          inactivityMs,
        );
      });

      const readResult = await Promise.race([
        reader.read(),
        wsErrorPromise.then(() => ({ done: false as const, value: new Uint8Array(0) })),
        inactivityTimer,
      ]).finally(() => clearTimeout(inactivityHandle));

      const { done, value } = readResult;
      if (wsError) throw wsError;
      if (done) break;

      // FIX-B: detect streams that emit only zero-length chunks (never trips inactivity timer
      // because reads resolve instantly, and never trips the byte cap because no bytes arrive).
      if (value.byteLength === 0) {
        zeroReads++;
        if (zeroReads > MAX_ZERO_READS) {
          throw new Error(`ensureModelFile: download stalled: no progress after ${MAX_ZERO_READS} zero-length chunks from ${url}`);
        }
        continue;
      }
      zeroReads = 0; // reset on any real progress
      accumulated += value.byteLength;
      if (accumulated > maxBytes) {
        reader.cancel().catch(() => undefined);
        await destroyAndWait(ws);
        throw new Error(
          `ensureModelFile: download exceeded 500 MB cap (${maxBytes} bytes) for ${url}`,
        );
      }
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          ws.write(value, (err) => (err ? reject(err) : resolve()));
        }),
        wsErrorPromise,
      ]);
      if (wsError) throw wsError;
    }
  } catch (streamErr) {
    reader.cancel().catch(() => undefined);
    await destroyAndWait(ws);
    throw streamErr;
  } finally {
    reader.releaseLock();
  }

  await Promise.race([
    new Promise<void>((resolve, reject) => {
      ws.end((err?: Error | null) => (err ? reject(err) : resolve()));
    }),
    wsErrorPromise,
  ]);

  // Verify content-length matches actual bytes received
  if (expectedLength !== null && accumulated !== expectedLength) {
    throw new Error(
      `ensureModelFile: incomplete download: got ${accumulated} of ${expectedLength} bytes for ${url}`,
    );
  }

  return accumulated;
}
