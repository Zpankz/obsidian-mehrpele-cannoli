// Goal nodes: an action node (colour "2") whose text is an ```mcp block runs a
// LangGraph agent over the cannoli-server's MCP tools (providers.ts:getGoalCompletion).
// An agent failure must reach the node as an error with its real cause.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CannoliObjectStatus } from "../src/graph";
import { runCanvas } from "./helpers/run";

const box = { width: 200, height: 100 };

const goalCanvas = {
  nodes: [
    {
      id: "goal",
      type: "text",
      text: "```mcp\nList the files in the vault\n```",
      color: "2",
      x: 0,
      y: 0,
      ...box,
    },
    { id: "out", type: "text", text: "", color: "6", x: 400, y: 0, ...box },
  ],
  edges: [
    {
      id: "e1",
      fromNode: "goal",
      fromSide: "right",
      toNode: "out",
      toSide: "left",
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("goal nodes", () => {
  it("goal agent error marks node error", async () => {
    // The cannoli-server answers, but has no MCP servers: the agent refuses to run.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/mcp-servers/sse")) {
        return new Response(JSON.stringify({ servers: {} }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { finished, stoppages, run } = await runCanvas(goalCanvas, {
      isMock: false,
      timeoutMs: 10_000,
      runArgs: {
        llmConfigs: [
          {
            provider: "ollama",
            model: "test-model",
            baseURL: "http://127.0.0.1:9",
          },
        ],
        cannoliServer: { url: "http://cannoli-server.test", secret: "s3cret" },
      },
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(finished).toBe(true);
    expect(run.graph.goal.status).toBe(CannoliObjectStatus.Error);
    expect(run.graph.out.status).not.toBe(CannoliObjectStatus.Complete);
    expect(stoppages).toHaveLength(1);
    expect(stoppages[0].reason).toBe("error");
    expect(stoppages[0].message).toContain("No MCP servers found");
  }, 20_000);
});
