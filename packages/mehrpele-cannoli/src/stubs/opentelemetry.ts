// No-op stand-in for every @opentelemetry/* and @arizeai/* import (README: Security). Only core's
// src/instrumentation.ts imports these, and that file is stubbed too; this keeps any other
// importer inert. A new named import fails the build, which is the point.
class Noop {
  constructor(..._args: unknown[]) {}
  addSpanProcessor(_p: unknown): void {}
  register(): void {}
}

export class WebTracerProvider extends Noop {}
export class BatchSpanProcessor extends Noop {}
export class Resource extends Noop {}
export class OTLPTraceExporter extends Noop {}
export const SEMRESATTRS_PROJECT_NAME = "project.name";
