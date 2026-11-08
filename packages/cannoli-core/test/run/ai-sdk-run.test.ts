// Whole runs on the AI SDK engine (P1.3), against a fake Ollama endpoint
// passed as modelFetch, so the real provider code runs without a network.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CannoliObjectStatus } from "../../src/graph";
import { AiSdkModelPort } from "../../src/model/ai-sdk/adapter";
import { LangchainModelPort } from "../../src/model/langchain";
import type { Persistor } from "../../src/persistor";
import { ollamaFetch } from "../helpers/fakeFetch";
import { runCanvas } from "../helpers/run";

const box = { width: 200, height: 100 };
const ollama = [
  {
    provider: "ollama" as const,
    model: "qwen3.5:4b",
    baseURL: "http://localhost:11434",
  },
];

/** prompt → call → content */
const callCanvas = (prompt: string) => ({
  nodes: [
    { id: "call", type: "text", text: prompt, x: 0, y: 0, ...box },
    { id: "out", type: "text", text: "", color: "6", x: 400, y: 0, ...box },
  ],
  edges: [
    {
      id: "e1",
      fromNode: "call",
      fromSide: "right",
      toNode: "out",
      toSide: "left",
    },
  ],
});

function memoryPersistor(): { persistor: Persistor; log: string[] } {
  const log: string[] = [];
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      log.push(`${method} ${JSON.stringify(args)}`);
    };
  return {
    log,
    persistor: {
      start: record("start"),
      editNode: record("editNode"),
      editEdge: record("editEdge"),
      addError: record("addError"),
      addWarning: record("addWarning"),
      editOriginalParallelGroupLabel: record("editOriginalParallelGroupLabel"),
      setConfig: () => {},
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runs on the AI SDK engine", () => {
  it("a call streams its reply into the content node", async () => {
    const { fetch, requests } = ollamaFetch("Hello from the AI SDK.");
    const { run, stoppages } = await runCanvas(callCanvas("Say hello"), {
      isMock: false,
      runArgs: {
        llmConfigs: ollama,
        providerEngine: "ai-sdk",
        modelFetch: fetch,
      },
    });

    expect(run.model).toBeInstanceOf(AiSdkModelPort);
    expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);
    expect(run.graph.out.status).toBe(CannoliObjectStatus.Complete);
    expect(run.graph.out.text).toBe("Hello from the AI SDK.");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(requests[0].body.model).toBe("qwen3.5:4b");
    expect(JSON.stringify(requests[0].body.messages)).toContain("Say hello");
  });

  it("the langchain engine keeps the LangChain port", async () => {
    const { fetch, requests } = ollamaFetch("unused");
    const { run } = await runCanvas(callCanvas("Say hello"), {
      isMock: true,
      runArgs: {
        llmConfigs: ollama,
        providerEngine: "langchain",
        modelFetch: fetch,
      },
    });
    expect(run.model).toBeInstanceOf(LangchainModelPort);
    expect(requests).toHaveLength(0);
  });

  it("a goal node falls back to the LangChain port", async () => {
    const { fetch: modelFetch, requests } = ollamaFetch("unused");
    // The cannoli-server answers, but has no MCP servers: the agent refuses.
    const serverFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/mcp-servers/sse")) {
        return new Response(JSON.stringify({ servers: {} }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", serverFetch);
    const goalSpy = vi.spyOn(LangchainModelPort.prototype, "goal");

    const canvas = callCanvas("```mcp\nList the files in the vault\n```");
    canvas.nodes[0] = { ...canvas.nodes[0], color: "2" } as never;
    const { run, stoppages } = await runCanvas(canvas, {
      isMock: false,
      timeoutMs: 10_000,
      runArgs: {
        llmConfigs: ollama,
        providerEngine: "ai-sdk",
        modelFetch,
        cannoliServer: { url: "http://cannoli-server.test", secret: "s3cret" },
      },
    });

    expect(run.model).toBeInstanceOf(AiSdkModelPort);
    expect(goalSpy).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
    expect(stoppages[0].reason).toBe("error");
    expect(stoppages[0].message).toContain("No MCP servers found");
  }, 20_000);

  it("provider keys are redacted from persisted text and requests", async () => {
    const key = "sk-provider-key-0123456789";
    const { fetch, requests } = ollamaFetch("Done.");
    const { persistor, log } = memoryPersistor();
    const { stoppages } = await runCanvas(
      {
        nodes: [
          {
            id: "content",
            type: "text",
            text: `The key is ${key}`,
            color: "6",
            x: 0,
            y: 0,
            ...box,
          },
          {
            id: "call",
            type: "text",
            text: "Repeat {{k}}",
            x: 400,
            y: 0,
            ...box,
          },
          {
            id: "out",
            type: "text",
            text: "",
            color: "6",
            x: 800,
            y: 0,
            ...box,
          },
        ],
        edges: [
          {
            id: "e1",
            fromNode: "content",
            fromSide: "right",
            toNode: "call",
            toSide: "left",
            label: "k",
          },
          {
            id: "e2",
            fromNode: "call",
            fromSide: "right",
            toNode: "out",
            toSide: "left",
          },
        ],
      },
      {
        isMock: false,
        runArgs: {
          llmConfigs: [{ ...ollama[0], apiKey: key }],
          providerEngine: "ai-sdk",
          modelFetch: fetch,
          persistor,
        },
      },
    );

    expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);
    const persisted = log.join("\n");
    expect(persisted).toContain("«secret:provider-key-ollama»");
    expect(persisted).not.toContain(key);
    const sent = requests.map((r) => JSON.stringify(r.body)).join("\n");
    expect(sent).toContain("«secret:provider-key-ollama»");
    expect(sent).not.toContain(key);
    // The key still authenticates the request.
    expect(requests[0].headers.authorization).toBe(`Bearer ${key}`);
  });
});
