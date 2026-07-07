export interface TimeoutSentinel {
  status: "timeout";
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | TimeoutSentinel> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<TimeoutSentinel>((resolve) => {
    timeout = setTimeout(() => resolve({ status: "timeout" }), ms);
  });

  return Promise.race([
    promise,
    timeoutPromise,
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}
