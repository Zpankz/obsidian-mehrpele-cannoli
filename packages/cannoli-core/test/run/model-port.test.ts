// Run calls models only through ModelPort (DESIGN §4.2, P1.2). These drive
// Run.callLLMStream with a port assigned to run.model.
import { describe, expect, it } from "vitest";
import { LangchainModelPort } from "../../src/model/langchain";
import type { ModelFetch } from "../../src/model/fetch";
import type { ModelPort } from "../../src/model/port";
import type { ModelStreamEvent } from "../../src/model/types";
import type { GenericCompletionParams } from "../../src/providers";
import { Run } from "../../src/run";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cannoli = {
  nodes: [
    { id: "p", type: "text", text: "Hi", x: 0, y: 0, width: 200, height: 100 },
  ],
  edges: [],
};

const request: GenericCompletionParams = {
  messages: [{ role: "user", content: "hi" }],
  model: "fake",
};

function runWith(model: ModelPort) {
  const run = new Run({ cannoli, isMock: false, config: { pLimit: 1 } });
  run.model = model;
  return run;
}

/** A port whose stream is the given generator. */
function port(
  stream: () => AsyncGenerator<ModelStreamEvent>,
): ModelPort & { closed: number } {
  const p = {
    closed: 0,
    generate: () => Promise.reject(new Error("unused")),
    stream() {
      const events = stream();
      const close = events.return.bind(events);
      events.return = (value) => {
        p.closed++;
        return close(value);
      };
      return events;
    },
  };
  return p;
}

async function collect(stream: AsyncIterable<string>) {
  let out = "";
  for await (const part of stream) out += part;
  return out;
}

describe("Run with a ModelPort", () => {
  it("streams text deltas and records usage", async () => {
    const run = runWith(
      port(async function* () {
        yield { type: "text-delta", text: "Hel" };
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 1 } };
        yield { type: "text-delta", text: "lo" };
        yield {
          type: "finish",
          result: {
            text: "Hello",
            messages: [],
            usage: { inputTokens: 4, outputTokens: 2 },
            finishReason: "stop",
          },
        };
      }),
    );
    const stream = await run.callLLMStream(request);
    if (typeof stream === "string" || stream instanceof Error) {
      throw new Error(`expected a stream, got ${String(stream)}`);
    }
    expect(await collect(stream)).toBe("Hello");
    expect(run.usage.fake).toMatchObject({
      numberOfCalls: 1,
      promptTokens: 4,
      completionTokens: 2,
    });
  });

  it("an error event fails the stream", async () => {
    const run = runWith(
      port(async function* () {
        yield { type: "text-delta", text: "partial" };
        yield { type: "error", error: new Error("upstream broke") };
        yield { type: "text-delta", text: " more" };
      }),
    );
    const stream = await run.callLLMStream(request);
    if (typeof stream === "string" || stream instanceof Error) {
      throw new Error(`expected a stream, got ${String(stream)}`);
    }
    await expect(collect(stream)).rejects.toThrow("upstream broke");
  });

  it("a stream that fails on its first event returns an Error and frees its slot", async () => {
    let attempts = 0;
    const run = runWith(
      port(async function* () {
        attempts++;
        await Promise.reject(new Error("refused"));
        yield { type: "text-delta", text: "never" };
      }),
    );
    for (let i = 0; i < 3; i++) {
      expect(await run.callLLMStream(request)).toBeInstanceOf(Error);
    }
    expect(attempts).toBe(3);
  });

  it("a stop before the first event closes the port's stream", async () => {
    const stalled = port(async function* () {
      await sleep(10_000);
      yield { type: "text-delta", text: "too late" };
    });
    const run = runWith(stalled);
    const call = run.callLLMStream(request);
    await sleep(20);
    run.stop();
    await expect(call).rejects.toBeDefined();
    expect(stalled.closed).toBe(1);
    // The slot is free again.
    const fresh = await Promise.race([
      run.llmLimit(async () => "fresh"),
      sleep(500).then(() => "slot still held"),
    ]);
    expect(fresh).toBe("fresh");
  });
});

// Host builds may replace the compatibility port with an SDK-only implementation.
// The constructor must receive the same explicit transport as the default SDK port.
describe("compatibility port transport context", () => {
  it("keeps distinct run transports on their corresponding fallback ports", () => {
    const fetchA: ModelFetch = async () => new Response("A");
    const fetchB: ModelFetch = async () => new Response("B");
    const make = (modelFetch?: ModelFetch) =>
      new Run({
        cannoli,
        providerEngine: "langchain",
        modelFetch,
        llmConfigs: [{ provider: "openai", model: "fake", apiKey: "fake-key" }],
      });
    const a = make(fetchA).model;
    const b = make(fetchB).model;
    const defaultPort = make().model;
    expect(a).toBeInstanceOf(LangchainModelPort);
    expect(b).toBeInstanceOf(LangchainModelPort);
    expect((a as LangchainModelPort).modelFetch).toBe(fetchA);
    expect((b as LangchainModelPort).modelFetch).toBe(fetchB);
    expect((defaultPort as LangchainModelPort).modelFetch).toBeUndefined();
  });
});
