import type { ModelFetch } from "../../src/model/fetch";
// AiSdkModelPort (DESIGN §4.2, P1.3): Message[] to the AI SDK and back, run
// through the real provider packages against a fake fetch.
import { generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiSdkModelPort, toAiSdkPrompt } from "../../src/model/ai-sdk/adapter";
import {
  createProviderModel,
  providersFromLegacyConfigs,
  type AiSdkProviderConfig,
} from "../../src/model/ai-sdk/providers";
import { fromLegacyParams, toLegacyResponse } from "../../src/model/legacy";
import { MockModelPort } from "../../src/model/mock";
import type {
  GenerateRequest,
  Message,
  ModelStreamEvent,
} from "../../src/model/types";
import {
  chatChunks,
  chatCompletion,
  fakeFetch,
  jsonResponse,
  sseResponse,
} from "../helpers/fakeFetch";

// Pass generateText/streamText through, keeping the options they were called with.
const calls = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock("ai", async (importOriginal) => {
  const ai = await importOriginal<typeof import("ai")>();
  return {
    ...ai,
    generateText: ((options: Record<string, unknown>) => {
      calls.options.push(options);
      return ai.generateText(options as never);
    }) as typeof ai.generateText,
    streamText: ((options: Record<string, unknown>) => {
      calls.options.push(options);
      return ai.streamText(options as never);
    }) as typeof ai.streamText,
  };
});

beforeEach(() => {
  calls.options.length = 0;
});

const OLLAMA: AiSdkProviderConfig = {
  id: "ollama",
  kind: "ollama",
  baseURL: "http://localhost:11434",
};

function req(
  messages: Message[],
  extra: Partial<GenerateRequest> = {},
): GenerateRequest {
  return {
    model: "ollama:qwen3.5:4b",
    messages,
    signal: new AbortController().signal,
    ...extra,
  };
}

async function collect(events: AsyncIterable<ModelStreamEvent>) {
  const out: ModelStreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("AiSdkModelPort", () => {
  it("maps Message[] to AI SDK prompt and back", async () => {
    const { fetch, requests } = fakeFetch(() =>
      jsonResponse(
        chatCompletion(
          {
            content: "Picking A.",
            reasoning_content: "A fits.",
            tool_calls: [
              {
                id: "call_2",
                type: "function",
                function: { name: "choose", arguments: '{"choice":"A"}' },
              },
            ],
          },
          undefined,
          "tool_calls",
        ),
      ),
    );
    const port = new AiSdkModelPort({ providers: [OLLAMA], fetch });
    const result = await port.generate(
      req(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "Look:" },
              {
                type: "image",
                data: "data:image/png;base64,iVBORw0K",
                mediaType: "image/png",
              },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "Need a tool." },
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "lookup",
                input: { q: "x" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_1",
                toolName: "lookup",
                output: "found",
              },
            ],
          },
          { role: "user", content: "Choose." },
        ],
        {
          tools: [
            {
              name: "choose",
              description: "Pick one",
              inputSchema: {
                type: "object",
                properties: { choice: { type: "string", enum: ["A", "B"] } },
                required: ["choice"],
              },
            },
          ],
          toolChoice: { toolName: "choose" },
          temperature: 0.2,
          maxOutputTokens: 50,
        },
      ),
    );

    const body = requests[0].body;
    expect(requests[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(body.model).toBe("qwen3.5:4b");
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(50);
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "choose" },
    });
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "choose" }),
      }),
    ]);
    const messages = body.messages as Record<string, unknown>[];
    expect(messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Look:" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBORw0K" },
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "Need a tool.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: '{"q":"x"}' },
        },
      ],
    });
    expect(messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "found",
    });
    expect(messages[3]).toEqual({ role: "user", content: "Choose." });

    // And back: reasoning, text and the tool call in one assistant message.
    expect(result.text).toBe("Picking A.");
    expect(result.finishReason).toBe("tool-calls");
    expect(result.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "A fits." },
          { type: "text", text: "Picking A." },
          {
            type: "tool-call",
            toolCallId: "call_2",
            toolName: "choose",
            input: { choice: "A" },
          },
        ],
      },
    ]);
    // The graph still reads the legacy function_call.
    expect(toLegacyResponse(result)).toMatchObject({
      role: "assistant",
      function_call: { name: "choose", args: { choice: "A" } },
    });
  });

  it("system messages hoisted / mid-history allowed", async () => {
    const leading = await toAiSdkPrompt(
      req([
        { role: "system", content: "Be brief." },
        { role: "system", content: "Use English." },
        { role: "user", content: "Hi" },
      ]),
    );
    expect(leading.instructions).toEqual([
      { role: "system", content: "Be brief." },
      { role: "system", content: "Use English." },
    ]);
    expect(leading.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(leading.allowSystemInMessages).toBe(false);

    const withInstructions = await toAiSdkPrompt(
      req([{ role: "user", content: "Hi" }], { instructions: "Top." }),
    );
    expect(withInstructions.instructions).toEqual([
      { role: "system", content: "Top." },
    ]);

    const mid = await toAiSdkPrompt(
      req([
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "system", content: "Now be formal." },
        { role: "user", content: "Again" },
      ]),
    );
    expect(mid.instructions).toEqual([
      { role: "system", content: "Be brief." },
    ]);
    expect(mid.allowSystemInMessages).toBe(true);
    expect(mid.messages[2]).toEqual({
      role: "system",
      content: "Now be formal.",
    });

    // End to end: the SDK accepts the mid-history system turn.
    const { fetch, requests } = fakeFetch(() =>
      jsonResponse(chatCompletion({ content: "ok" })),
    );
    const port = new AiSdkModelPort({ providers: [OLLAMA], fetch });
    await port.generate(
      req([
        { role: "user", content: "Hi" },
        { role: "system", content: "Now be formal." },
        { role: "user", content: "Again" },
      ]),
    );
    expect(calls.options[0].allowSystemInMessages).toBe(true);
    expect(
      (requests[0].body.messages as { role: string }[]).map((m) => m.role),
    ).toEqual(["user", "system", "user"]);

    // A prompt that is only system text still goes out (as legacy did).
    await port.generate(req([{ role: "system", content: "Say hi." }]));
    expect(
      (requests[1].body.messages as { role: string }[]).map((m) => m.role),
    ).toEqual(["system"]);
  });

  it("usage incl cachedInputTokens", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(
        chatCompletion(
          { content: "ok" },
          {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 40 },
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        ),
      ),
    );
    const port = new AiSdkModelPort({ providers: [OLLAMA], fetch });
    const result = await port.generate(req([{ role: "user", content: "Hi" }]));
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      reasoningTokens: 5,
    });

    // Anthropic reports cache writes too.
    const anthropic = fakeFetch(() =>
      jsonResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 20,
        },
      }),
    );
    const claude = new AiSdkModelPort({
      providers: [{ id: "anthropic", kind: "anthropic", apiKey: "sk-test" }],
      fetch: anthropic.fetch,
    });
    const usage = (
      await claude.generate(
        req([{ role: "user", content: "Hi" }], {
          model: "anthropic:claude-sonnet-5-5",
        }),
      )
    ).usage;
    expect(usage).toMatchObject({
      outputTokens: 5,
      cachedInputTokens: 20,
      cacheWriteTokens: 30,
    });
  });

  it("abort propagates", async () => {
    const { fetch, requests } = fakeFetch(
      (r) =>
        new Promise<Response>((_, reject) => {
          r.signal?.addEventListener("abort", () => reject(r.signal?.reason));
        }),
    );
    const port = new AiSdkModelPort({ providers: [OLLAMA], fetch });
    const controller = new AbortController();
    const pending = port.generate(
      req([{ role: "user", content: "Hi" }], { signal: controller.signal }),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow();
    expect(calls.options[0].abortSignal).toBe(controller.signal);
    expect(requests[0].signal?.aborted).toBe(true);

    // A stream reports the abort as its last event.
    const stopped = new AbortController();
    const events = port.stream(
      req([{ role: "user", content: "Hi" }], { signal: stopped.signal }),
    );
    const pendingEvents = collect(events);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    stopped.abort(new Error("stopped"));
    const out = await pendingEvents;
    expect(out.at(-1)?.type).toBe("error");
  });

  it("stopWhen explicit", async () => {
    const { fetch, requests } = fakeFetch(() =>
      jsonResponse(
        chatCompletion(
          {
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "choose", arguments: '{"choice":"A"}' },
              },
            ],
          },
          undefined,
          "tool_calls",
        ),
      ),
    );
    const port = new AiSdkModelPort({ providers: [OLLAMA], fetch });
    await port.generate(
      req([{ role: "user", content: "Hi" }], {
        tools: [{ name: "choose", inputSchema: { type: "object" } }],
      }),
    );
    expect(calls.options[0].stopWhen).toBeTypeOf("function");
    // One step: the tool call comes back to the caller, not to another step.
    expect(requests).toHaveLength(1);
  });

  it("stream yields text-delta x3, then usage, then finish", async () => {
    const { fetch, requests } = fakeFetch(() =>
      sseResponse(
        chatChunks(["Hel", "lo ", "there"], {
          prompt_tokens: 7,
          completion_tokens: 3,
        }),
      ),
    );
    const port = new AiSdkModelPort({ providers: [OLLAMA], fetch });
    const events = await collect(
      port.stream(req([{ role: "user", content: "Hi" }])),
    );
    expect(requests[0].body.stream).toBe(true);
    expect(requests[0].body.stream_options).toEqual({ include_usage: true });
    expect(events.map((e) => e.type)).toEqual([
      "text-delta",
      "text-delta",
      "text-delta",
      "usage",
      "finish",
    ]);
    expect(
      events.flatMap((e) => (e.type === "text-delta" ? [e.text] : [])),
    ).toEqual(["Hel", "lo ", "there"]);
    const finish = events.at(-1);
    expect(finish).toMatchObject({
      type: "finish",
      result: {
        text: "Hello there",
        finishReason: "stop",
        usage: { inputTokens: 7, outputTokens: 3 },
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Hello there" }],
          },
        ],
      },
    });
    // The provider's own zeros pass through unchanged.
    expect(events[3]).toEqual({
      type: "usage",
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
    });
  });

  it("unknown provider uses fallback", async () => {
    const fallback = new MockModelPort({ text: "from fallback" });
    const port = new AiSdkModelPort({ providers: [OLLAMA], fallback });
    const result = await port.generate(
      req([{ role: "user", content: "Hi" }], { model: "anthropic:claude-x" }),
    );
    expect(result.text).toBe("from fallback");
    const events = await collect(
      port.stream(
        req([{ role: "user", content: "Hi" }], { model: "openai:gpt-x" }),
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      result: { text: "from fallback" },
    });

    // Legacy azure_openai has no AI SDK provider here: it goes to the fallback.
    const legacy = fromLegacyParams(
      {
        provider: "azure_openai",
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      },
      new AbortController().signal,
    );
    expect((await port.generate(legacy)).text).toBe("from fallback");

    const bare = new AiSdkModelPort({ providers: [OLLAMA] });
    await expect(
      bare.generate(
        req([{ role: "user", content: "Hi" }], { model: "anthropic:claude-x" }),
      ),
    ).rejects.toThrow(/No AI SDK provider for "anthropic:claude-x"/);
  });

  it("legacy request config picks the provider and overrides baseURL and apiKey", async () => {
    const { fetch, requests } = fakeFetch(() =>
      jsonResponse(chatCompletion({ content: "ok" })),
    );
    const providers = providersFromLegacyConfigs([
      { provider: "ollama", baseURL: "http://localhost:11434" },
      { provider: "groq", apiKey: "gsk-config" },
    ]);
    const port = new AiSdkModelPort({ providers, fetch });
    const legacy = fromLegacyParams(
      {
        provider: "ollama",
        model: "llama3:8b",
        baseURL: "http://box:11434/",
        top_p: 0.5,
        stop: "END,STOP",
        messages: [{ role: "user", content: "Hi" }],
      },
      new AbortController().signal,
    );
    await port.generate(legacy);
    expect(requests[0].url).toBe("http://box:11434/v1/chat/completions");
    expect(requests[0].body).toMatchObject({
      model: "llama3:8b",
      top_p: 0.5,
      stop: ["END", "STOP"],
    });

    await port.generate(
      fromLegacyParams(
        {
          provider: "groq",
          model: "llama-3.3-70b",
          apiKey: "gsk-request",
          messages: [{ role: "user", content: "Hi" }],
        },
        new AbortController().signal,
      ),
    );
    expect(requests[1].url).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
    expect(requests[1].headers.authorization).toBe("Bearer gsk-request");
  });

  it("anthropic factory sends browser-access header", async () => {
    const { fetch, requests } = fakeFetch(() =>
      jsonResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const port = new AiSdkModelPort({
      providers: [{ id: "anthropic", kind: "anthropic", apiKey: "sk-test" }],
      fetch,
    });
    await port.generate(
      req([{ role: "user", content: "Hi" }], {
        model: "anthropic:claude-sonnet-5-5",
      }),
    );
    expect(requests[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(
      requests[0].headers["anthropic-dangerous-direct-browser-access"],
    ).toBe("true");
    expect(requests[0].headers["x-api-key"]).toBe("sk-test");
    expect(requests[0].body.model).toBe("claude-sonnet-5-5");
  });

  it("ollama baseURL normalised to /v1", async () => {
    for (const baseURL of [
      "http://localhost:11434",
      "http://localhost:11434/",
      "http://localhost:11434/v1",
      "http://localhost:11434/v1/",
    ]) {
      const { fetch, requests } = fakeFetch(() =>
        jsonResponse(chatCompletion({ content: "ok" })),
      );
      const model = createProviderModel(
        { id: "ollama", kind: "ollama", baseURL },
        "qwen3.5:4b",
        fetch,
      );
      await generateText({ model, prompt: "Hi" });
      expect(requests[0].url).toBe(
        "http://localhost:11434/v1/chat/completions",
      );
    }
  });

  it("maps legacy configs to provider configs", () => {
    expect(
      providersFromLegacyConfigs([
        { provider: "openai", apiKey: "sk-o" },
        { provider: "gemini", apiKey: "g-k" },
        { provider: "anthropic", apiKey: "sk-a", baseURL: "" },
        { provider: "ollama", baseURL: "http://localhost:11434" },
        { provider: "groq", apiKey: "gsk" },
        { provider: "azure_openai", apiKey: "az" },
      ]),
    ).toEqual([
      { id: "openai", kind: "openai", apiKey: "sk-o" },
      { id: "google", kind: "google", apiKey: "g-k" },
      { id: "anthropic", kind: "anthropic", apiKey: "sk-a" },
      { id: "ollama", kind: "ollama", baseURL: "http://localhost:11434" },
      {
        id: "groq",
        kind: "openai-compatible",
        apiKey: "gsk",
        baseURL: "https://api.groq.com/openai/v1",
      },
    ]);
  });
});

describe("MockModelPort", () => {
  it("is deterministic in generate and stream", async () => {
    const port = new MockModelPort({ text: "one two three" });
    const a = await port.generate(req([{ role: "user", content: "Hi" }]));
    const b = await port.generate(req([{ role: "user", content: "Hi" }]));
    expect(a).toEqual(b);
    expect(a.text).toBe("one two three");
    const events = await collect(
      port.stream(req([{ role: "user", content: "Hi" }])),
    );
    expect(events.map((e) => e.type)).toEqual([
      "text-delta",
      "text-delta",
      "text-delta",
      "usage",
      "finish",
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", result: a });
  });
});

it("image URL downloads use the injected fetch and call abort signal", async () => {
  const controller = new AbortController();
  const fetch = vi.fn<ModelFetch>(async (_input, init) => {
    expect(init?.signal).toBe(controller.signal);
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    });
  });
  const prompt = await toAiSdkPrompt(
    req(
      [
        {
          role: "user",
          content: [
            {
              type: "image",
              data: "https://image.test/picture.png",
              mediaType: "image/png",
            },
          ],
        },
      ],
      { signal: controller.signal },
    ),
    fetch,
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(prompt.messages[0].content).toEqual([
    { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
  ]);
});
