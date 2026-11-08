// Same pass-through contract as SDK tracing in non-Node runtimes. No diagnostics,
// AsyncLocalStorage or subscribers are loaded by the browser companion.
export async function runWithTracingChannelSpan<T>(_message: unknown, execute: () => PromiseLike<T>): Promise<T> {
  return await execute();
}
export function openTelemetryChannelSpanContext({ completion }: { message: unknown; completion: PromiseLike<unknown> }): undefined {
  void Promise.resolve(completion).catch(() => {});
  return undefined;
}
