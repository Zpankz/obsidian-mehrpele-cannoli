                                                                                           
// original turns LangSmith tracing on from LANGSMITH_TRACING / LANGCHAIN_TRACING_V2 and friends,
// which the Electron renderer can see in process.env. Mehrpele Flows ignores the environment:
// tracing is on only if a caller passes true explicitly, and nothing in the bundle does.
export const isTracingEnabled = (tracingEnabled?: boolean): boolean => tracingEnabled ?? false;
