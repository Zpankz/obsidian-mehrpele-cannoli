/** Stop waiting promptly; the underlying native read/query is read-only and may finish later. */
export function cancellable<T>(
  operation: () => T | PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error("Workflow stopped during preparation"));
    if (signal?.aborted) {
      stop();
      return;
    }
    signal?.addEventListener("abort", stop, { once: true });
    const clear = () => signal?.removeEventListener("abort", stop);
    Promise.resolve()
      .then(() => {
        if (signal?.aborted) throw Error("Workflow stopped during preparation");
        return operation();
      })
      .then(
        (value) => {
          clear();
          resolve(value);
        },
        (error) => {
          clear();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
  });
}
