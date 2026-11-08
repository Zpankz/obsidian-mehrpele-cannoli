// A LangChain chat model that reports usage_metadata the way ChatOllama does
// (on the result, and on the last streamed chunk) and records the signal
// each call was given. No network.
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output,
});

export class UsageModel extends BaseChatModel {
  /** The signal of every call, in order. */
  signals: (AbortSignal | undefined)[] = [];

  constructor() {
    super({});
  }

  _llmType() {
    return "usage-fake";
  }

  async _generate(
    _messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    this.signals.push(options.signal);
    return {
      generations: [
        {
          text: "hello",
          message: new AIMessage({
            content: "hello",
            usage_metadata: usage(4, 2),
          }),
        },
      ],
    };
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): AsyncGenerator<ChatGenerationChunk> {
    this.signals.push(options.signal);
    for (const text of ["hel", "lo"]) {
      yield new ChatGenerationChunk({
        text,
        message: new AIMessageChunk({ content: text }),
      });
    }
    yield new ChatGenerationChunk({
      text: "",
      message: new AIMessageChunk({ content: "", usage_metadata: usage(6, 3) }),
    });
  }
}
