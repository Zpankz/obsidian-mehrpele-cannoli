// The Cannoli engine, as Mehrpele Flows uses it. Reached only through
// `import("./flows/engine")` (MehrpeleFlowsPlugin.loadEngine), so esbuild emits it as a
// lazily initialised module: nothing here is evaluated when the plugin loads.
//
// Deliberately not re-exported: bake / callCannoliFunction (Val Town), the built-in actions
// (Val Town, Exa, DALL·E) and the cannoli-server client (README: Security).

/** Marks the engine module in main.js; the bundle test checks it sits behind a lazy init. */
export const ENGINE_MARKER = "mehrpele-flows:engine:v1";

export { run, resultsRun, Run, RunController, RunEventBus, LLMProvider, canvasDataSchema } from "@mehrpele/cannoli-core";
export type {
  Action,
  CanvasData,
  FileManager,
  HttpTemplate,
  LLMConfig,
  Persistor,
  Replacer,
  ResponseTextFetcher,
  RunArgs,
  RunEvent,
  SecretResolver,
  Stoppage,
} from "@mehrpele/cannoli-core";
