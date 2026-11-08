import type { Persistor } from "../../src/persistor";
import { describe, expect, it } from "vitest";
import { abortableStream, RunController } from "../../src/runtime/controller";
import { Run } from "../../src/run";
import { RunEventBus, type RunEvent } from "../../src/runtime/events";
import type { GenerateResult, ModelStreamEvent } from "../../src/model/types";

const box = { type: "text", x: 0, y: 0, width: 200, height: 100 };
const canvas = {
  nodes: [
    { ...box, id: "c", text: "hi" },
    { ...box, id: "o", text: "", color: "6" },
  ],
  edges: [
    { id: "e", fromNode: "c", toNode: "o", fromSide: "right", toSide: "left" },
  ],
};
const request = {
  model: "fake",
  messages: [{ role: "user" as const, content: "hi" }],
};
const result: GenerateResult = {
  text: "ok",
  messages: [],
  usage: { inputTokens: 7, outputTokens: 4 },
  finishReason: "stop",
};
function setup() {
  const events = new RunEventBus();
  const seen: RunEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const run = new Run({
    cannoli: structuredClone(canvas),
    events,
    llmConfigs: [{ provider: "ollama", model: "fake" }],
  });
  return { run, events, seen };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function cancelAfterResolution(run: Run, stop: boolean) {
  queueMicrotask(() =>
    queueMicrotask(() => {
      if (stop) run.stop();
      else run.nodeExecutionFailed(run.graph.c, new Error("parallel failure"));
    }),
  );
}

describe("terminal races", () => {
  for (const kind of ["generate", "goal"] as const) {
    it.each([false, true])(
      `${kind} discards a fulfilled response when cancellation wins before continuation (stop=%s)`,
      async (stop) => {
        const { run, seen } = setup();
        const respond = () => {
          const p = Promise.resolve(result);
          cancelAfterResolution(run, stop);
          return p;
        };
        const model = {
          generate: respond,
          goal: respond,
          async *stream(): AsyncGenerator<ModelStreamEvent> {},
        };
        run.model = model;
        const call =
          kind === "generate"
            ? run.callLLM(request)
            : run.callGoalAgent({ request });
        await expect(call).rejects.toBeDefined();
        expect(run.usage).toEqual({});
        expect(seen.at(-1)).toMatchObject({
          t: "run-finish",
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      },
    );
  }

  it("does not yield a resolved iterator result after cancellation", async () => {
    const controller = new RunController();
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            const p = Promise.resolve({ done: false as const, value: "late" });
            queueMicrotask(() => queueMicrotask(() => controller.stop()));
            return p;
          },
          async return() {
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const iterator = abortableStream(source, controller.signal)[
      Symbol.asyncIterator
    ]();
    await expect(iterator.next()).rejects.toBeDefined();
  });

  it("does not publish graph output when a model-finish observer stops the run", async () => {
    const { run, events, seen } = setup();
    run.model = {
      async generate() {
        return result;
      },
      async *stream() {},
    };
    events.subscribe((e) => {
      if (e.t === "model-finish") run.stop();
    });
    await run.start();
    await tick();
    expect(run.graph.o.text).toBe("");
    expect(seen.at(-1)).toMatchObject({
      t: "run-finish",
      status: "stopped",
      usage: result.usage,
    });
  });

  it.each(["stop", "error"] as const)(
    "settles buffered tail and accepted usage before terminal %s",
    async (kind) => {
      const events = new RunEventBus();
      const run = new Run({
        cannoli: structuredClone(canvas),
        events,
        secrets: { KEY: "abcabc" },
      });
      const usage = { inputTokens: 7, outputTokens: 4 };
      run.model = {
        async generate() {
          return result;
        },
        async *stream() {
          yield { type: "text-delta", text: "abc" };
          yield { type: "usage", usage };
        },
      };
      const early: RunEvent[] = [],
        late: RunEvent[] = [];
      events.subscribe((e) => {
        early.push(e);
        if (e.t === "text-delta") {
          if (kind === "stop") run.stop();
          else
            run.nodeExecutionFailed(run.graph.c, new Error("parallel failure"));
        }
      });
      events.subscribe((e) => late.push(e));
      const stream = await run.callLLMStream(request);
      if (typeof stream === "string" || stream instanceof Error)
        throw new Error("expected stream");
      try {
        for await (const part of stream) void part;
      } catch {
        /* cancellation */
      }
      await tick();
      expect(early).toEqual(late);
      expect(late.map((e) => e.t)).toEqual([
        "run-start",
        "model-request",
        "text-delta",
        "model-finish",
        "run-finish",
      ]);
      expect(late.at(-1)).toMatchObject({
        usage,
        status: kind === "stop" ? "stopped" : "error",
      });
      expect(run.usage.fake).toMatchObject({
        promptTokens: 7,
        completionTokens: 4,
      });
    },
  );

  it("does not publish output when its executing observer stops the run", async () => {
    const { run, events, seen } = setup();
    run.model = {
      async generate() {
        return result;
      },
      async *stream() {},
    };
    events.subscribe((e) => {
      if (e.t === "node-status" && e.id === "o" && e.status === "executing")
        run.stop();
    });
    await run.start();
    await tick();
    expect(run.graph.o.text).toBe("");
    expect(run.graph.o.status).not.toBe("complete");
    expect(seen.at(-1)?.t).toBe("run-finish");
  });

  it("does not emit secret lints after validation has terminated the run", async () => {
    const events = new RunEventBus();
    const seen: RunEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const data = structuredClone(canvas);
    data.nodes[0].text = "Use {{KEY}}";
    const run = new Run({
      cannoli: data,
      events,
      secrets: { KEY: "secret-value" },
    });
    run.validate = () => {
      run.nodeExecutionFailed(run.graph.c, new Error("invalid graph"));
    };
    await run.start();
    await tick();
    expect(seen.at(-1)?.t).toBe("run-finish");
    expect(seen.some((e) => e.t === "lint")).toBe(false);
  });

  it("attributes a partial goal request to the configured model", async () => {
    const { run, seen } = setup();
    const model = {
      async generate() {
        return result;
      },
      async goal() {
        return result;
      },
      async *stream() {},
    };
    run.model = model;
    await run.callGoalAgent({ request: { messages: request.messages } });
    expect(seen.find((e) => e.t === "model-request")).toMatchObject({
      model: "ollama:fake",
    });
    run.stop();
  });

  it("isolates asynchronous observer rejections without delaying other observers", async () => {
    const { events } = setup();
    events.subscribe(async () => {
      await Promise.resolve();
      throw new Error("observer rejected");
    });
    const seen: RunEvent[] = [];
    events.subscribe((e) => seen.push(e));
    events.emit({ t: "text-delta", id: "c", callId: "x", text: "hello" });
    expect(seen).toHaveLength(1);
    await tick();
  });

  it("stops reset and startup immediately when a pending-status observer cancels", async () => {
    const { run, events, seen } = setup();
    run.graph.o.setText("keep until reset reaches this node");
    let terminal: unknown;
    run.onFinish = () => {
      terminal = structuredClone(run.canvasData);
    };
    events.subscribe((e) => {
      if (e.t === "node-status" && e.status === "pending") run.stop();
    });
    await run.start();
    await tick();
    expect(run.canvasData).toEqual(terminal);
    expect(run.graph.o.text).toBe("keep until reset reaches this node");
    expect(seen.at(-1)?.t).toBe("run-finish");
  });

  it("flushes an accepted redactor tail before another branch's terminal error", async () => {
    const events = new RunEventBus();
    const seen: RunEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const run = new Run({
      cannoli: structuredClone(canvas),
      events,
      secrets: { KEY: "abcabc" },
    });
    run.model = {
      async generate() {
        return result;
      },
      async *stream() {
        yield { type: "usage", usage: result.usage! };
        yield { type: "text-delta", text: "abc" };
        await new Promise(() => {});
      },
    };
    const stream = await run.callLLMStream(request);
    if (typeof stream === "string" || stream instanceof Error)
      throw new Error("expected stream");
    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: "abc" });
    expect(seen.some((e) => e.t === "text-delta")).toBe(false);
    run.nodeExecutionFailed(run.graph.c, new Error("another branch failed"));
    await expect(iterator.next()).rejects.toBeDefined();
    await tick();
    expect(seen.slice(-3).map((e) => e.t)).toEqual([
      "text-delta",
      "model-finish",
      "run-finish",
    ]);
    expect(seen.at(-3)).toMatchObject({ text: "abc" });
    expect(seen.at(-1)).toMatchObject({ usage: result.usage, status: "error" });
  });

  it("does not publish a call result when cancellation queues before the caller resumes", async () => {
    const { run, events } = setup();
    run.model = {
      async generate() {
        return result;
      },
      async *stream() {},
    };
    events.subscribe((e) => {
      if (e.t === "model-finish") queueMicrotask(() => run.stop());
    });
    await run.start();
    await tick();
    expect(run.graph.c.status).not.toBe("complete");
    expect(run.graph.o.text).toBe("");
    const edge = run.canvasData!.edges.find((e) => e.id === "e")!;
    expect(edge.cannoliData.content).toBeUndefined();
  });

  it.each([undefined, null, false])(
    "reports a flush rejection as failure regardless of its value (%s)",
    async (rejected) => {
      let finish = (reason: string) => {
        void reason;
      };
      const done = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const persistor: Persistor = {
        async start() {},
        async editNode() {},
        async editEdge() {},
        async addError() {},
        async addWarning() {},
        async editOriginalParallelGroupLabel() {},
        setConfig() {},
        flush: () => Promise.reject(rejected),
      };
      const run = new Run({
        cannoli: structuredClone(canvas),
        llmConfigs: [{ provider: "ollama", model: "fake" }],
        persistor,
        onFinish: (s) => finish(s.reason),
      });
      run.model = {
        async generate() {
          return result;
        },
        async *stream() {},
      };
      await run.start();
      expect(await done).toBe("error");
    },
  );

  it("reports effective defaults on the built-in LangChain generate and stream paths", async () => {
    const events = new RunEventBus();
    const seen: RunEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const run = new Run({
      cannoli: structuredClone(canvas),
      events,
      providerEngine: "langchain",
      llmConfigs: [{ provider: "ollama", model: "fake" }],
    });
    const observed: unknown[] = [];
    run.llm!.getCompletion = async (input) => {
      observed.push(input);
      return { role: "assistant", content: "ok" };
    };
    run.llm!.getCompletionStream = async (input) => {
      observed.push(input);
      return (async function* () {
        yield "ok";
      })();
    };
    await run.callLLM({ messages: request.messages });
    const stream = await run.callLLMStream({ messages: request.messages });
    if (typeof stream === "string" || stream instanceof Error)
      throw new Error("expected stream");
    for await (const part of stream) void part;
    expect(observed).toHaveLength(2);
    expect(seen.filter((e) => e.t === "model-request")).toMatchObject([
      { model: "ollama:fake" },
      { model: "ollama:fake" },
    ]);
    run.stop();
  });

  it("persists accepted output when its complete observer cancels", async () => {
    const events = new RunEventBus();
    const persisted = new Map<string, unknown>();
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const persistor: Persistor = {
      async start() {},
      async editNode(node) {
        persisted.set(node.id, structuredClone(node));
      },
      async editEdge() {},
      async addError() {},
      async addWarning() {},
      async editOriginalParallelGroupLabel() {},
      setConfig() {},
    };
    const run = new Run({
      cannoli: structuredClone(canvas),
      events,
      persistor,
      llmConfigs: [{ provider: "ollama", model: "fake" }],
      onFinish: () => finish(),
    });
    run.model = {
      async generate() {
        return result;
      },
      async *stream() {},
    };
    events.subscribe((e) => {
      if (e.t === "node-status" && e.id === "o" && e.status === "complete")
        run.stop();
    });
    await run.start();
    await done;
    expect(run.graph.o.text).toBe("ok");
    expect(persisted.get("o")).toMatchObject({
      text: "ok",
      cannoliData: { status: "complete" },
    });
  });

  it("does not mutate graph output after terminal failure", async () => {
    const { run, seen } = setup();
    run.model = {
      generate: () => {
        const p = Promise.resolve(result);
        cancelAfterResolution(run, false);
        return p;
      },
      async *stream() {},
    };
    await run.start();
    await tick();
    expect(run.usage).toEqual({});
    expect(run.graph.o.text).toBe("");
    expect(run.graph.o.status).not.toBe("complete");
    expect(seen.at(-1)?.t).toBe("run-finish");
  });

  it("rejects a fulfilled first stream event after cancellation and frees its slot", async () => {
    const { run } = setup();
    let closed = 0;
    run.model = {
      async generate() {
        return result;
      },
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                const p = Promise.resolve({
                  done: false as const,
                  value: { type: "text-delta" as const, text: "late" },
                });
                cancelAfterResolution(run, false);
                return p;
              },
              async return() {
                closed++;
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      },
    };
    await expect(run.callLLMStream(request)).rejects.toBeDefined();
    expect(closed).toBe(1);
    expect(run.usage).toEqual({});
    expect(await run.llmLimit(async () => "free")).toBe("free");
  });

  it.each(["generate", "goal", "stream"] as const)(
    "run-start cancellation is terminal for direct %s calls",
    async (kind) => {
      const { run, events, seen } = setup();
      let calls = 0;
      const respond = async () => {
        calls++;
        return result;
      };
      const model = {
        generate: respond,
        goal: respond,
        async *stream(): AsyncGenerator<ModelStreamEvent> {
          calls++;
          yield { type: "text-delta", text: "late" };
        },
      };
      run.model = model;
      events.subscribe((e) => {
        if (e.t === "run-start") run.stop();
      });
      const call =
        kind === "generate"
          ? run.callLLM(request)
          : kind === "goal"
            ? run.callGoalAgent({ request })
            : run.callLLMStream(request);
      await expect(call).rejects.toBeDefined();
      expect(calls).toBe(0);
      expect(seen.map((e) => e.t)).toEqual(["run-start", "run-finish"]);
    },
  );

  it("delivers request before nested terminal events to every observer", async () => {
    const { run, events } = setup();
    run.model = {
      async generate() {
        throw new Error("must not call");
      },
      async *stream() {},
    };
    events.subscribe((e) => {
      if (e.t === "model-request") run.stop();
    });
    const later: string[] = [];
    events.subscribe((e) => later.push(e.t));
    await expect(run.callLLM(request)).rejects.toBeDefined();
    expect(later).toEqual([
      "run-start",
      "model-request",
      "model-finish",
      "run-finish",
    ]);
  });
});
