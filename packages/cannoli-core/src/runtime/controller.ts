/**
 * Cancels a run (DESIGN §11.2). The signal reaches every model call and
 * run-path fetch; stop() aborts them and the run finishes as stopped.
 *
 * pause() is not implemented yet: nothing in the engine can suspend a node
 * mid-call, so a stub would promise behaviour that doesn't exist.
 */
export class RunController {
  private readonly abortController = new AbortController();

  /** Aborts when stop() is called. Pass it to every cancellable call. */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Stop the run. Safe to call more than once; later calls do nothing. */
  stop(reason = "Stopped by user"): void {
    if (this.abortController.signal.aborted) return;
    this.abortController.abort(new StopError(reason));
  }
}

/** The abort reason for a user stop, so callers can tell it from a failure. */
export class StopError extends Error {
  name = "AbortError";
}

/**
 * Pass a stream through until the signal aborts, then throw its reason
 * without waiting for the next chunk. Closing the source is requested in
 * the background. A provider that ignores its own signal may leave its
 * request open, but it can't hold the consumer or its concurrency slot.
 */
export async function* abortableStream<T>(
  stream: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  let finished = false;
  try {
    while (true) {
      const next = await raceAbort(iterator.next(), signal);
      if (signal.aborted) throw signal.reason;
      if (next.done) {
        finished = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!finished) {
      // Don't await: a source stuck mid-chunk only returns after that chunk.
      void iterator.return?.()?.catch(() => {});
    }
  }
}

/** Wrap a fetcher so each request also carries the run's signal. */
export function withSignal<O extends { signal?: AbortSignal | null }, R>(
  fetch: (url: string, options: O) => R,
  signal: AbortSignal,
): (url: string, options?: O) => R {
  return (url, options = {} as O) =>
    fetch(url, {
      ...options,
      // Keep the caller's own signal (e.g. its timeout) as well.
      signal: options.signal
        ? AbortSignal.any([options.signal, signal])
        : signal,
    });
}

/**
 * Settle with the promise, or reject with the signal's reason as soon as it
 * aborts. For calls that can't be cancelled themselves (Obsidian's
 * requestUrl, a provider that ignores its signal), so a stop never waits.
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    // The promise may still reject (its source saw the abort); handle that.
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
