// LangchainModelPort: the existing LLMProvider behind ModelPort (DESIGN §4.2,
// P1.2). It converts each request back to the legacy shape and calls
// LLMProvider unchanged. P5.2 deletes it with the LangChain paths.
import type { ModelFetch } from "./fetch";
import type { LLMProvider } from "../providers";
import {
  fromLegacyMessages,
  fromLegacyResponse,
  toLegacyParams,
} from "./legacy";
import type { GoalAgentPort } from "./port";
import type {
  GenerateRequest,
  GenerateResult,
  Message,
  ModelStreamEvent,
  Usage,
} from "./types";

export class LangchainModelPort implements GoalAgentPort {
  /**
   * Keep the run's SDK transport available to host replacements of this port.
   * The stock legacy provider still owns its LangChain clients and transport.
   */
  constructor(
    readonly llm: LLMProvider,
    readonly modelFetch?: ModelFetch,
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    let usage: Usage | undefined;
    const response = await this.llm.getCompletion(toLegacyParams(req), {
      signal: req.signal,
      onUsage: (u) => (usage = u),
    });
    return fromLegacyResponse(response, usage);
  }

  async *stream(req: GenerateRequest): AsyncGenerator<ModelStreamEvent> {
    let usage: Usage | undefined;
    let fresh = false;
    const parts = await this.llm.getCompletionStream(toLegacyParams(req), {
      signal: req.signal,
      onUsage: (u) => {
        usage = u;
        fresh = true;
      },
    });
    let text = "";
    const newUsage = function* (): Generator<ModelStreamEvent> {
      if (fresh && usage) yield { type: "usage", usage };
      fresh = false;
    };
    for await (const part of parts) {
      yield* newUsage();
      text += part;
      yield { type: "text-delta", text: part };
    }
    yield* newUsage();
    yield {
      type: "finish",
      result: {
        text,
        messages: [{ role: "assistant", content: text }],
        ...(usage ? { usage } : {}),
        finishReason: "stop",
      },
    };
  }

  async goal(
    req: GenerateRequest,
    opts: { onReasoningMessagesUpdated?: (messages: Message[]) => void } = {},
  ): Promise<GenerateResult> {
    const { onReasoningMessagesUpdated } = opts;
    const response = await this.llm.getGoalCompletion(
      {
        ...toLegacyParams(req),
        onReasoningMessagesUpdated: onReasoningMessagesUpdated
          ? (messages) =>
              onReasoningMessagesUpdated(fromLegacyMessages(messages))
          : undefined,
      },
      { signal: req.signal },
    );
    return fromLegacyResponse(response);
  }
}
