// LangchainModelPort wraps LLMProvider behind ModelPort (DESIGN §4.2, P1.2).
// It must not change what LangChain is sent or what the graph gets back.
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";
import {
  LLMProvider,
  type GenericCompletionParams,
  type GenericCompletionResponse,
} from "../../src/providers";
import {
  fromLegacyParams,
  fromLegacyMessages,
  toLegacyResponse,
} from "../../src/model/legacy";
import { LangchainModelPort } from "../../src/model/langchain";
import type { ModelStreamEvent } from "../../src/model/types";

const usage = { input_tokens: 5, output_tokens: 2, total_tokens: 7 };

/** Records what LangChain is sent; answers with a tool call once tools are bound. */
class RecordingModel extends BaseChatModel {
  sent: string[] = [];
  tools: unknown[] | null = null;

  constructor() {
    super({});
  }

  _llmType() {
    return "recording-fake";
  }

  // A fake: bindTools returns the model itself.
  bindTools(tools: unknown[]) {
    this.tools = tools;
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.sent.push(JSON.stringify(messages));
    const message = this.tools
      ? new AIMessage({
          content: "",
          tool_calls: [{ name: "choice", args: { choice: "B" }, id: "c9" }],
          usage_metadata: usage,
        })
      : new AIMessage({ content: "Hello there", usage_metadata: usage });
    return { generations: [{ text: "", message }] };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
  ): AsyncGenerator<ChatGenerationChunk> {
    this.sent.push(JSON.stringify(messages));
    for (const text of ["Hel", "lo"]) {
      yield new ChatGenerationChunk({
        text,
        message: new AIMessageChunk({ content: text }),
      });
    }
    yield new ChatGenerationChunk({
      text: "",
      message: new AIMessageChunk({ content: "", usage_metadata: usage }),
    });
  }
}

function provider() {
  const model = new RecordingModel();
  const llm = new LLMProvider({
    configs: [
      { provider: "ollama", model: "fake" },
      { provider: "azure_openai", model: "fake-deployment" },
    ],
  });
  // The merged config LangChain's client would be built from.
  const configs: unknown[] = [];
  llm.getChatClient = (args) => {
    configs.push(llm.getMergedConfig(args));
    return model;
  };
  return { llm, model, configs };
}

const choiceFunction = {
  name: "choice",
  description: "Enter your choice using this function.",
  parameters: {
    type: "object",
    properties: { choice: { type: "string", enum: ["A", "B"] } },
    required: ["choice"],
  },
};

const fixtures: Record<string, GenericCompletionParams> = {
  "plain prompt": {
    messages: [{ role: "user", content: "Say hello." }],
    provider: "ollama",
    model: "fake",
    baseURL: "http://127.0.0.1:11434",
    max_tokens: 64,
  },
  "system message and history": {
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "narrator", content: "A pause." },
      { role: "user", content: "Again" },
    ],
    provider: "ollama",
    model: "fake",
    temperature: 0.3,
  },
  // Its model ref says "openai"; LangChain must still get azure_openai.
  "azure provider": {
    messages: [{ role: "user", content: "Say hello." }],
    provider: "azure_openai",
    model: "fake-deployment",
  },
  vision: {
    messages: [{ role: "user", content: "What is this?" }],
    imageReferences: [{ url: "data:image/png;base64,AAAA", messageIndex: 0 }],
    provider: "ollama",
    model: "fake",
    enableVision: true,
  },
  "choice tool call": {
    messages: [{ role: "user", content: "A or B?" }],
    provider: "ollama",
    model: "fake",
    functions: [choiceFunction],
    function_call: { name: "choice" },
  },
  "tool result follow-up": {
    messages: [
      { role: "user", content: "A or B?" },
      {
        role: "assistant",
        content: "",
        function_call_id: "c9",
        function_call: {
          name: "choice",
          args: { choice: "B" },
          // @ts-expect-error LangChain ToolCall fields beyond the legacy type
          id: "c9",
          type: "tool_call",
        },
      },
      { role: "tool", content: "B", function_call_id: "c9" },
    ],
    provider: "ollama",
    model: "fake",
  },
};

describe("LangchainModelPort", () => {
  it("LangchainModelPort.generate equals legacy getCompletion on fixtures", async () => {
    for (const [name, params] of Object.entries(fixtures)) {
      const legacy = provider();
      let legacyUsage: unknown;
      const expected = await legacy.llm.getCompletion(structuredClone(params), {
        onUsage: (u) => (legacyUsage = u),
      });

      const viaPort = provider();
      const port = new LangchainModelPort(viaPort.llm);
      const signal = new AbortController().signal;
      const result = await port.generate(
        fromLegacyParams(structuredClone(params), signal),
      );

      expect(legacy.model.sent, name).toHaveLength(1);
      expect(viaPort.model.sent, name).toEqual(legacy.model.sent);
      expect(viaPort.configs, name).toStrictEqual(legacy.configs);
      expect(toLegacyResponse(result), name).toEqual(expected);
      expect(result.usage, name).toEqual(legacyUsage);
    }
  });

  it("stream yields the legacy stream's text, usage, then finish", async () => {
    const params = fixtures["system message and history"];
    const legacy = provider();
    const parts: string[] = [];
    for await (const part of await legacy.llm.getCompletionStream(
      structuredClone(params),
    )) {
      parts.push(part);
    }

    const viaPort = provider();
    const port = new LangchainModelPort(viaPort.llm);
    const events: ModelStreamEvent[] = [];
    for await (const event of port.stream(
      fromLegacyParams(structuredClone(params), new AbortController().signal),
    )) {
      events.push(event);
    }

    expect(viaPort.model.sent).toEqual(legacy.model.sent);
    expect(viaPort.configs).toStrictEqual(legacy.configs);
    const deltas = events.flatMap((e) =>
      e.type === "text-delta" ? [e.text] : [],
    );
    expect(deltas).toEqual(parts);
    const finish = events.at(-1);
    expect(finish).toMatchObject({
      type: "finish",
      result: {
        text: "Hello",
        usage: { inputTokens: 5, outputTokens: 2 },
        finishReason: "stop",
      },
    });
    expect(events).toContainEqual({
      type: "usage",
      usage: { inputTokens: 5, outputTokens: 2 },
    });
  });

  it("passes the request signal to the provider", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const llm = {
      getCompletion: async (
        _p: GenericCompletionParams,
        opts?: { signal?: AbortSignal },
      ): Promise<GenericCompletionResponse> => {
        seen.push(opts?.signal);
        return { role: "assistant", content: "ok" };
      },
    } as unknown as LLMProvider;
    const signal = new AbortController().signal;
    await new LangchainModelPort(llm).generate({
      model: "ollama:fake",
      messages: fromLegacyMessages([{ role: "user", content: "hi" }]),
      signal,
    });
    expect(seen).toEqual([signal]);
  });
});
