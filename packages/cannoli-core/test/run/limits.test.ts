// pLimit (DESIGN §11.5): every model call, streaming included, goes through the
// run's limiter, sized from config.pLimit.
import { describe, expect, it } from "vitest";
import type { GenericCompletionParams } from "../../src/providers";
import { Run } from "../../src/run";
import { runCanvas } from "../helpers/run";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake provider that records how many calls are in flight at once. */
function fakeLlm(delayMs = 20) {
  const stats = { inFlight: 0, max: 0, calls: 0 };
  const enter = () => {
    stats.calls++;
    stats.inFlight++;
    stats.max = Math.max(stats.max, stats.inFlight);
  };
  const exit = () => stats.inFlight--;
  const llm = {
    initialized: true,
    getMergedConfig: () => ({ model: "fake", provider: "ollama" }),
    async getCompletion() {
      enter();
      await sleep(delayMs);
      exit();
      return { role: "assistant" as const, content: "ok" };
    },
    // Like LangChain's .stream(): resolves to a stream, which then yields
    // chunks over time. The call is in flight until the stream ends.
    async getCompletionStream() {
      enter();
      async function* chunks() {
        try {
          for (const part of ["a", "b", "c"]) {
            await sleep(delayMs / 3);
            yield part;
          }
        } finally {
          exit();
        }
      }
      return chunks();
    },
  };
  return { llm, stats };
}

const box = { width: 200, height: 100 };
const text = (id: string, t: string, x: number, y: number, color?: string) => ({
  id,
  type: "text",
  text: t,
  x,
  y,
  ...box,
  ...(color ? { color } : {}),
});
const edge = (id: string, fromNode: string, toNode: string) => ({
  id,
  fromNode,
  fromSide: "right",
  toNode,
  toSide: "left",
});

// Eight independent prompt → call → output chains, all roots at once.
const eightCalls = {
  nodes: Array.from({ length: 8 }, (_, i) => [
    text(`p${i}`, `Prompt ${i}`, 0, i * 200, "6"),
    text(`c${i}`, "", 300, i * 200),
    text(`o${i}`, "", 600, i * 200, "6"),
  ]).flat(),
  edges: Array.from({ length: 8 }, (_, i) => [
    edge(`e${i}a`, `p${i}`, `c${i}`),
    edge(`e${i}b`, `c${i}`, `o${i}`),
  ]).flat(),
};

const request: GenericCompletionParams = {
  messages: [{ role: "user", content: "hi" }],
  model: "fake",
};

describe("limits", () => {
  it("pLimit from config bounds concurrent calls", async () => {
    const { llm, stats } = fakeLlm();
    const { finished, stoppages, run } = await runCanvas(eightCalls, {
      isMock: false,
      runArgs: { config: { pLimit: 2 } },
      beforeStart: (r) => {
        r.llm = llm as unknown as Run["llm"];
      },
    });

    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);
    expect(stats.calls).toBe(8);
    expect(stats.max).toBe(2);
    for (let i = 0; i < 8; i++) expect(run.graph[`o${i}`].text).toBe("ok");
  });

  it("streaming calls are limited", async () => {
    const { llm, stats } = fakeLlm();
    const run = new Run({
      cannoli: eightCalls,
      isMock: false,
      config: { pLimit: 2 },
    });
    run.llm = llm as unknown as Run["llm"];

    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const stream = await run.callLLMStream(request);
        if (stream instanceof Error || typeof stream === "string") {
          throw new Error(`expected a stream, got ${String(stream)}`);
        }
        let out = "";
        for await (const part of stream) out += part;
        return out;
      }),
    );

    expect(results).toEqual(Array(8).fill("abc"));
    expect(stats.calls).toBe(8);
    expect(stats.max).toBe(2);
  });

  it("a stream that fails to start releases its slot", async () => {
    const run = new Run({
      cannoli: eightCalls,
      isMock: false,
      config: { pLimit: 1 },
    });
    const { llm } = fakeLlm();
    let attempts = 0;
    run.llm = {
      ...llm,
      async getCompletionStream() {
        attempts++;
        throw new Error("refused");
      },
    } as unknown as Run["llm"];

    for (let i = 0; i < 3; i++) {
      const res = await run.callLLMStream(request);
      expect(res).toBeInstanceOf(Error);
    }
    expect(attempts).toBe(3);
  });
});
