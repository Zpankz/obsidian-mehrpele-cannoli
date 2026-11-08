import { BaseCallbackHandler } from "@langchain/core/callbacks/base";

/**
 * LangChain attaches a LangSmith tracer to a call when LANGSMITH_TRACING,
 * LANGCHAIN_TRACING_V2 (or a sibling) is "true" in process.env, unless a
 * handler named "langchain_tracer" is already attached. This no-op handler
 * takes that name, so tracing can't be switched on from the environment.
 * Pass it at the outermost invoke/stream: inner runs inherit it.
 */
class TracingBlocker extends BaseCallbackHandler {
  name = "langchain_tracer";
}

export const tracingBlocker = () => new TracingBlocker();

/** Call options that keep LangSmith tracing off for this call. */
export const untraced = () => ({ callbacks: [tracingBlocker()] });
