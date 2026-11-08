// No-op stand-in for langsmith's dist/singletons/otel.js (README: Security). The original keeps
// global hooks for an OpenTelemetry exporter; Mehrpele Flows never sets one, so this keeps only
// the inert mocks that langsmith's client.js and traceable.js call unconditionally.
const tracer = {
  startActiveSpan(_name: string, ...args: unknown[]): unknown {
    const fn = args[args.length - 1];
    return typeof fn === "function" ? (fn as () => unknown)() : undefined;
  },
};

const trace = {
  getTracer: (_name?: string, _version?: string) => tracer,
  getActiveSpan: (): undefined => undefined,
  setSpan: <T>(context: T, _span?: unknown): T => context,
  getSpan: (_context?: unknown): undefined => undefined,
  setSpanContext: <T>(context: T, _spanContext?: unknown): T => context,
  getTracerProvider: (): undefined => undefined,
  setGlobalTracerProvider: (_provider?: unknown): boolean => false,
};

const context = {
  active: () => ({}),
  with: <R>(_context: unknown, fn: () => R): R => fn(),
};

export function getOTELTrace(): typeof trace {
  return trace;
}

export function getOTELContext(): typeof context {
  return context;
}

export function setOTELInstances(_otel?: unknown): void {}

export function getDefaultOTLPTracerComponents(): undefined {
  return undefined;
}

export function setDefaultOTLPTracerComponents(_components?: unknown): void {}
