// model/legacy.ts converts between the legacy GenericCompletionResponse shape
// and the Message model (DESIGN §4.2). LangchainModelPort sends every request
// through both directions, so the round trip must not lose anything the
// LangChain path or the graph reads.
import { describe, expect, it } from "vitest";
import type {
  GenericCompletionParams,
  GenericCompletionResponse,
} from "../../src/providers";
import {
  fromLegacyMessages,
  fromLegacyParams,
  fromLegacyResponse,
  toLegacyMessages,
  toLegacyParams,
  toLegacyResponse,
} from "../../src/model/legacy";

// A LangChain tool call, as fn_call returns it.
const toolCall: GenericCompletionResponse = {
  role: "assistant",
  content: "",
  function_call_id: "call_1",
  function_call: {
    name: "choice",
    args: { choice: "Yes" },
    // @ts-expect-error LangChain ToolCall fields beyond the legacy type
    id: "call_1",
    type: "tool_call",
  },
};

const conversation: GenericCompletionResponse[] = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "Pick one." },
  toolCall,
  { role: "tool", content: "Yes", function_call_id: "call_1" },
  { role: "assistant", content: "Done." },
  // A mock run's tool call: no id.
  {
    role: "assistant",
    content: "",
    function_call: { name: "form", args: { a: "Mock answer" } },
  },
  // A role a node's config can set; LangChain sends it as a user ChatMessage.
  { role: "narrator", content: "Meanwhile." },
];

describe("legacy messages", () => {
  it("round-trips GenericCompletionResponse incl. function_call", () => {
    const messages = fromLegacyMessages(conversation);
    expect(toLegacyMessages(messages).messages).toEqual(conversation);
  });

  it("maps a tool call and its result to Message parts", () => {
    const [, , call, result] = fromLegacyMessages(conversation);
    expect(call).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "choice",
          input: { choice: "Yes" },
        },
      ],
    });
    expect(result).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "choice",
          output: "Yes",
        },
      ],
    });
  });

  it("moves image references onto their message and back", () => {
    const imageReferences = [
      { url: "data:image/png;base64,AAAA", messageIndex: 1 },
      { url: "https://example.com/cat.jpg", messageIndex: 1 },
    ];
    const messages = fromLegacyMessages(conversation, imageReferences);
    expect(messages[1].content).toEqual([
      { type: "text", text: "Pick one." },
      { type: "image", data: imageReferences[0].url, mediaType: "image/png" },
      { type: "image", data: imageReferences[1].url, mediaType: "image/*" },
    ]);
    expect(toLegacyMessages(messages)).toEqual({
      messages: conversation,
      imageReferences,
    });
  });
});

describe("legacy requests and responses", () => {
  const params: GenericCompletionParams = {
    messages: conversation.slice(0, 2),
    imageReferences: undefined,
    provider: "ollama",
    model: "qwen3.5:4b",
    baseURL: "http://127.0.0.1:11434",
    temperature: 0.2,
    max_tokens: 64,
    enableVision: false,
    functions: [
      {
        name: "choice",
        description: "Enter your choice using this function.",
        parameters: { type: "object", properties: {} },
      },
    ],
    function_call: { name: "choice" },
  };

  it("round-trips completion params", () => {
    const signal = new AbortController().signal;
    const request = fromLegacyParams(params, signal);
    expect(request).toMatchObject({
      model: "ollama:qwen3.5:4b",
      temperature: 0.2,
      maxOutputTokens: 64,
      toolChoice: { toolName: "choice" },
      tools: [{ name: "choice", inputSchema: params.functions![0].parameters }],
      signal,
    });
    expect(toLegacyParams(request)).toEqual(params);
  });

  it("keeps an unset provider and model unset", () => {
    // A goal node's request has neither: LLMProvider must use its defaults.
    const request = fromLegacyParams(
      { messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    );
    const back = toLegacyParams(request);
    expect(back.provider).toBeUndefined();
    expect(back.model).toBeUndefined();
  });

  it("round-trips a completion response", () => {
    for (const response of [toolCall, { role: "assistant", content: "Hi" }]) {
      const result = fromLegacyResponse(response, {
        inputTokens: 3,
        outputTokens: 1,
      });
      expect(toLegacyResponse(result)).toEqual(response);
    }
    expect(fromLegacyResponse(toolCall).finishReason).toBe("tool-calls");
    expect(fromLegacyResponse({ content: "Hi" }).text).toBe("Hi");
  });
});
