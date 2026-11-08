import { describe, expect, it, vi } from "vitest";
import { AiSdkModelPort } from "../../src/model/ai-sdk/adapter";
import { providersFromLegacyConfigs } from "../../src/model/ai-sdk/providers";
import { fromLegacyParams } from "../../src/model/legacy";
import { LangchainModelPort } from "../../src/model/langchain";
import { Run } from "../../src/run";
import {
  chatChunks,
  chatCompletion,
  fakeFetch,
  jsonResponse,
  ollamaFetch,
  sseResponse,
} from "../helpers/fakeFetch";
import { runCanvas } from "../helpers/run";

const messages = [{ role: "user", content: "Hi" }];

describe("legacy AI SDK compatibility on the wire", () => {
  it("keeps an omitted-provider call on the configured Azure fallback", async () => {
    const { fetch, requests } = ollamaFetch("unexpected");
    const fallback = vi
      .spyOn(LangchainModelPort.prototype, "generate")
      .mockResolvedValue({ text: "azure", finishReason: "stop", messages: [] });
    try {
      const run = new Run({
        cannoli: { nodes: [], edges: [] },
        isMock: false,
        providerEngine: "ai-sdk",
        llmConfigs: [
          { provider: "azure_openai", model: "azure-default", apiKey: "test" },
          { provider: "openai", model: "gpt-4o", apiKey: "test" },
        ],
        modelFetch: fetch,
      });
      expect(await run.callLLM({ messages })).toMatchObject({
        content: "azure",
      });
      expect(fallback).toHaveBeenCalledOnce();
      expect(
        fallback.mock.calls[0][0].providerOptions?.langchain,
      ).toMatchObject({ provider: "azure_openai" });
      expect(requests).toHaveLength(0);
    } finally {
      fallback.mockRestore();
    }
  });
  it.each([false, true])(
    "preserves OpenAI controls with stream=%s",
    async (stream) => {
      const { fetch, requests } = fakeFetch(() =>
        stream
          ? sseResponse(chatChunks(["ok"]))
          : jsonResponse(chatCompletion({ content: "ok" })),
      );
      const port = new AiSdkModelPort({
        providers: [{ id: "openai", kind: "openai", apiKey: "test" }],
        fetch,
      });
      const req = fromLegacyParams(
        {
          provider: "openai",
          model: "gpt-4o",
          messages,
          stop: "END,STOP",
          seed: 42,
          frequency_penalty: 0.4,
          presence_penalty: 0.6,
        },
        new AbortController().signal,
      );
      if (stream) {
        const events = [];
        for await (const event of port.stream(req)) events.push(event);
        expect(events.at(-1)?.type).toBe("finish");
      } else expect((await port.generate(req)).text).toBe("ok");
      expect(requests[0].url).toBe(
        "https://api.openai.com/v1/chat/completions",
      );
      expect(requests[0].body).toMatchObject({
        stop: ["END", "STOP"],
        seed: 42,
        frequency_penalty: 0.4,
        presence_penalty: 0.6,
      });
    },
  );

  it.each(["openai", "ollama"] as const)(
    "preserves %s base query at the actual endpoint",
    async (provider) => {
      const { fetch, requests } = ollamaFetch("ok");
      const port = new AiSdkModelPort({
        providers: providersFromLegacyConfigs([
          {
            provider,
            apiKey: "test",
            baseURL:
              "https://gateway.test/v1/?api-version=2024-01&tag=a&tag=b&encoded=a%2Fb",
          },
        ]),
        fetch,
      });
      const req = fromLegacyParams(
        { provider, model: "m", messages },
        new AbortController().signal,
      );
      await port.generate(req);
      for await (const _event of port.stream(req)) {
        /* drain */
      }
      for (const request of requests) {
        const url = new URL(request.url);
        expect(url.pathname).toBe("/v1/chat/completions");
        expect(url.searchParams.get("api-version")).toBe("2024-01");
        expect(url.searchParams.getAll("tag")).toEqual(["a", "b"]);
        expect(url.searchParams.get("encoded")).toBe("a/b");
      }
    },
  );

  it("uses configured model for direct Run calls and honors explicit overrides", async () => {
    const { fetch, requests } = ollamaFetch("ok");
    const run = new Run({
      cannoli: { nodes: [], edges: [] },
      isMock: false,
      providerEngine: "ai-sdk",
      llmConfigs: [
        {
          provider: "ollama",
          model: "configured:tag",
          baseURL: "http://localhost:11434",
          temperature: 0,
          max_tokens: 64,
          stop: "END",
        },
        { provider: "openai", model: "gpt-4o", apiKey: "test" },
      ],
      modelFetch: fetch,
    });
    expect(await run.callLLM({ messages })).toMatchObject({ content: "ok" });
    const defaultStream = await run.callLLMStream({ messages });
    if (defaultStream instanceof Error) throw defaultStream;
    for await (const _chunk of defaultStream) {
      /* drain */
    }
    expect(
      requests
        .slice(0, 2)
        .every((r) => new URL(r.url).hostname === "localhost"),
    ).toBe(true);
    expect(await run.callLLM({ provider: "ollama", messages })).toMatchObject({
      content: "ok",
    });
    const stream = await run.callLLMStream({ provider: "ollama", messages });
    if (stream instanceof Error) throw stream;
    for await (const _chunk of stream) {
      /* drain */
    }
    for (const request of requests.slice(0, 2)) {
      expect(request.body).toMatchObject({
        temperature: 0,
        max_tokens: 64,
        stop: ["END"],
      });
    }
    await run.callLLM({
      provider: "ollama",
      model: "override:tag",
      temperature: 0.7,
      max_tokens: 32,
      stop: "OVERRIDE",
      messages,
    });
    expect(requests.map((r) => r.body.model)).toEqual([
      "configured:tag",
      "configured:tag",
      "configured:tag",
      "configured:tag",
      "override:tag",
    ]);
    expect(requests.at(-1)?.body).toMatchObject({
      temperature: 0.7,
      max_tokens: 32,
      stop: ["OVERRIDE"],
    });
  });

  it.each([false, true])(
    "serializes safe form fields and loads labeled edges with collisions=%s",
    async (collision) => {
      const { fetch, requests } = fakeFetch((r) => {
        const tools = r.body.tools as {
          function: { parameters: { properties: Record<string, unknown> } };
        }[];
        const key = Object.keys(tools[0].function.parameters.properties)[0];
        return jsonResponse(
          chatCompletion(
            {
              content: "",
              tool_calls: [
                {
                  id: "f1",
                  type: "function",
                  function: {
                    name: "form",
                    arguments: JSON.stringify({ [key]: "Ada" }),
                  },
                },
              ],
            },
            undefined,
            "tool_calls",
          ),
        );
      });
      const { run, finished, stoppages } = await runCanvas(
        {
          nodes: [
            {
              id: "form",
              type: "text",
              text: "Fill the name",
              x: 0,
              y: 0,
              width: 200,
              height: 100,
            },
            {
              id: "out",
              type: "text",
              text: "",
              color: "6",
              x: 400,
              y: 0,
              width: 200,
              height: 100,
            },
            ...(collision
              ? [
                  {
                    id: "out2",
                    type: "text" as const,
                    text: "",
                    color: "6",
                    x: 400,
                    y: 200,
                    width: 200,
                    height: 100,
                  },
                ]
              : []),
          ],
          edges: [
            {
              id: "field",
              fromNode: "form",
              fromSide: "right",
              toNode: "out",
              toSide: "left",
              label: "First name",
              color: "6",
            },
            ...(collision
              ? [
                  {
                    id: "field2",
                    fromNode: "form",
                    fromSide: "right" as const,
                    toNode: "out2",
                    toSide: "left" as const,
                    label: "First-name",
                    color: "6",
                  },
                ]
              : []),
          ],
        },
        {
          isMock: false,
          runArgs: {
            providerEngine: "ai-sdk",
            llmConfigs: [
              {
                provider: "openai",
                model: "gpt-4o",
                apiKey: "test",
                baseURL: "https://gateway.test/v1",
              },
            ],
            modelFetch: fetch,
          },
        },
      );
      expect(finished).toBe(true);
      expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);
      expect(requests[0].body.tools).toMatchObject([
        {
          function: {
            parameters: {
              properties: { First_name: { type: "string" } },
              required: ["First_name"],
            },
          },
        },
      ]);
      expect(run.graph.out.text).toBe("Ada");
      if (collision) expect(run.graph.out2.text).toBe("Ada");
    },
  );
});
