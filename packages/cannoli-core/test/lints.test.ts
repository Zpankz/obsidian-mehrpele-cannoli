import { afterEach, describe, expect, it, vi } from "vitest";
import { lintSecretInPrompt } from "../src/language/lints";
import { Run } from "../src/run";
import { secretResolverFromRecord } from "../src/secrets";
import { verifiedData } from "./helpers/compile";
import { runCanvas } from "./helpers/run";

const box = { x: 0, y: 0, width: 200, height: 100 };
const SECRET_VALUE = "fixture-secret-value";
const secrets = secretResolverFromRecord({ MY_SECRET: SECRET_VALUE });

const edge = (id: string, fromNode: string, toNode: string, extra = {}) => ({
  id,
  fromNode,
  fromSide: "right",
  toNode,
  toSide: "left",
  ...extra,
});

// A call node (colourless) whose prompt references the secret, feeding an output node.
const callCanvas = {
  nodes: [
    { id: "call", type: "text", text: "Use the key {{MY_SECRET}} now", ...box },
    { id: "out", type: "text", text: "", color: "6", ...box, x: 400 },
  ],
  edges: [edge("e1", "call", "out")],
};

// A content node (purple) resolving the same reference, feeding an output node.
const contentCanvas = {
  nodes: [
    { id: "content", type: "text", text: "{{MY_SECRET}}", color: "6", ...box },
    { id: "out", type: "text", text: "", color: "6", ...box, x: 400 },
  ],
  edges: [edge("e1", "content", "out")],
};

// A choose node (call node with a choice arrow out) and an extract-style reference.
const chooseCanvas = {
  nodes: [
    { id: "pick", type: "text", text: "Pick using {{MY_SECRET}}", ...box },
    { id: "a", type: "text", text: "", color: "6", ...box, x: 400 },
    { id: "dyn", type: "text", text: "Read {{@MY_SECRET}}", ...box, y: 300 },
    { id: "b", type: "text", text: "", color: "6", ...box, x: 400, y: 300 },
  ],
  edges: [
    edge("e1", "pick", "a", { color: "3", label: "yes" }),
    edge("e2", "dyn", "b"),
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("L-secret-in-prompt", () => {
  it("secret name in call node text is an error", async () => {
    const lints = lintSecretInPrompt(verifiedData(callCanvas), ["MY_SECRET"]);
    expect(lints).toEqual([
      expect.objectContaining({
        code: "L-secret-in-prompt",
        severity: "error",
        nodeId: "call",
      }),
    ]);
    expect(lints[0].message).toContain("MY_SECRET");

    // The run fails before any LLM call, naming the node and the secret but not its value.
    const callLLM = vi.spyOn(Run.prototype, "callLLM");
    const callLLMStream = vi.spyOn(Run.prototype, "callLLMStream");
    const { finished, stoppages } = await runCanvas(callCanvas, {
      runArgs: { secrets },
    });

    expect(finished).toBe(true);
    expect(stoppages).toHaveLength(1);
    expect(stoppages[0].reason).toBe("error");
    expect(stoppages[0].message).toContain("L-secret-in-prompt");
    expect(stoppages[0].message).toContain("MY_SECRET");
    expect(stoppages[0].message).toContain("call");
    expect(stoppages[0].message).not.toContain(SECRET_VALUE);
    expect(callLLM).not.toHaveBeenCalled();
    expect(callLLMStream).not.toHaveBeenCalled();
  });

  it("flags choose nodes, but not extract-style references or unknown names", () => {
    const lints = lintSecretInPrompt(verifiedData(chooseCanvas), ["MY_SECRET"]);
    expect(lints.map((l) => l.nodeId)).toEqual(["pick"]);
    expect(lintSecretInPrompt(verifiedData(callCanvas), ["OTHER"])).toEqual([]);
  });

  it("does not flag a content node with the same reference", async () => {
    expect(
      lintSecretInPrompt(verifiedData(contentCanvas), ["MY_SECRET"]),
    ).toEqual([]);

    const { finished, stoppages } = await runCanvas(contentCanvas, {
      runArgs: { secrets },
    });
    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);
  });

  it("does not flag a name an incoming arrow supplies, and the run proceeds", async () => {
    const arrowCanvas = {
      nodes: [
        { id: "src", type: "text", text: "hello", color: "6", ...box },
        {
          id: "call",
          type: "text",
          text: "Use {{MY_SECRET}} now",
          ...box,
          x: 400,
        },
        { id: "out", type: "text", text: "", color: "6", ...box, x: 800 },
      ],
      edges: [
        edge("e0", "src", "call", { label: "MY_SECRET" }),
        edge("e1", "call", "out"),
      ],
    };
    expect(
      lintSecretInPrompt(verifiedData(arrowCanvas), ["MY_SECRET"]),
    ).toEqual([]);

    const { finished, stoppages } = await runCanvas(arrowCanvas, {
      runArgs: {
        secrets,
        llmConfigs: [{ provider: "openai", model: "gpt-4o" }],
      },
    });
    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);
  });

  it("does not flag a name a floating node supplies", () => {
    const floatingCanvas = {
      ...callCanvas,
      nodes: [
        ...callCanvas.nodes,
        {
          id: "float",
          type: "text",
          text: "[MY_SECRET]\nnot a secret",
          ...box,
          y: 400,
        },
      ],
    };
    expect(
      lintSecretInPrompt(verifiedData(floatingCanvas), ["MY_SECRET"]),
    ).toEqual([]);
  });

  it("does not flag a name a form node's field supplies", () => {
    // A form node (field arrow out) also sends its fields on its other arrows.
    const formCanvas = {
      nodes: [
        { id: "form", type: "text", text: "Fill in the token", ...box },
        { id: "f", type: "text", text: "", color: "6", ...box, x: 400 },
        { id: "call", type: "text", text: "Use {{MY_SECRET}}", ...box, y: 300 },
        { id: "out", type: "text", text: "", color: "6", ...box, y: 600 },
      ],
      edges: [
        edge("e1", "form", "f", { color: "6", label: "MY_SECRET" }),
        edge("e2", "form", "call"),
        edge("e3", "call", "out"),
      ],
    };
    const data = verifiedData(formCanvas);
    expect(data.nodes.find((n) => n.id === "form")?.cannoliData?.type).toBe(
      "form",
    );
    expect(lintSecretInPrompt(data, ["MY_SECRET"])).toEqual([]);
  });

  it("a call node never receives a secret value through the reference fallback", async () => {
    // With no secret names passed to the lint (e.g. a resolver whose names() is empty),
    // the call prompt must still keep the literal reference.
    const hidden = {
      get: (name: string) => (name === "MY_SECRET" ? SECRET_VALUE : null),
      names: () => [],
    };
    const prompts: string[] = [];
    vi.spyOn(Run.prototype, "callLLM").mockImplementation(async (request) => {
      prompts.push(JSON.stringify(request.messages));
      return { role: "assistant", content: "ok" };
    });
    const { stoppages } = await runCanvas(callCanvas, {
      runArgs: {
        secrets: hidden,
        llmConfigs: [{ provider: "openai", model: "gpt-4o" }],
      },
    });
    expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);
    expect(prompts.join("\n")).toContain("{{MY_SECRET}}");
    expect(prompts.join("\n")).not.toContain(SECRET_VALUE);
  });
});
