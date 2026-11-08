// No-op stand-in for cannoli-core's src/instrumentation.ts (tracing export to a remote
// collector) and for web-instrumentation-langchain. Mehrpele Flows has no telemetry or
// tracing export (README: Security), so nothing here sends anything.
export function createPhoenixWebTracerProvider(_args: unknown): undefined {
  return undefined;
}

export class LangChainInstrumentation {
  manuallyInstrument(_module: unknown): void {}
}
