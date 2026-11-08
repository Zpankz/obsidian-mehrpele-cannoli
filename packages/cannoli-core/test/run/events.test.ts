import { describe, expect, it } from "vitest";
import type { ModelPort } from "../../src/model/port";
import { Run } from "../../src/run";
import { RunEventBus, type RunEvent } from "../../src/runtime/events";
import { runCanvas } from "../helpers/run";
import type { Persistor, PersistorEdit } from "../../src/persistor";

const box = { x: 0, y: 0, width: 200, height: 100, type: "text" };
const canvas = {
  nodes: [
    { ...box, id: "p", text: "Hello", color: "6" },
    { ...box, id: "c", text: "" },
    { ...box, id: "o", text: "", color: "6" },
  ],
  edges: [
    { id: "a", fromNode: "p", toNode: "c", fromSide: "right", toSide: "left" },
    {
      id: "b",
      fromNode: "c",
      toNode: "o",
      fromSide: "right",
      toSide: "left",
      color: "4",
    },
  ],
};
const usage = { inputTokens: 3, outputTokens: 2 };
const port: ModelPort = {
  async generate() {
    return { text: "Hello world", messages: [], usage, finishReason: "stop" };
  },
  async *stream() {
    yield { type: "text-delta", text: "Hello " };
    yield { type: "text-delta", text: "world" };
    yield {
      type: "finish",
      result: {
        text: "Hello world",
        messages: [],
        usage,
        finishReason: "stop",
      },
    };
  },
};

describe("RunEventBus", () => {
  it("finishes only after final text is durable, without delaying graph completion for paint", async () => {
    const writes: (readonly PersistorEdit[])[] = [];
    const events = new RunEventBus();
    let graphComplete = false;
    let executingWrittenAfterGraphComplete = false;
    events.subscribe((e) => {
      if (e.t === "node-status" && e.id === "o" && e.status === "complete")
        graphComplete = true;
    });
    const persistor: Persistor = {
      async start() {},
      async editNode() {},
      async editEdge() {},
      async addError() {},
      async addWarning() {},
      async editOriginalParallelGroupLabel() {},
      setConfig() {},
      async applyBatch(edits) {
        writes.push(structuredClone(edits));
        if (
          edits.some(
            (e) =>
              e.type === "node" && e.node.cannoliData.status === "executing",
          )
        )
          executingWrittenAfterGraphComplete ||= graphComplete;
      },
    };
    const result = await runCanvas(canvas, {
      isMock: false,
      runArgs: {
        events,
        persistor,
        llmConfigs: [{ provider: "ollama", model: "fake" }],
      },
      beforeStart: (run) => {
        run.model = port;
      },
    });
    expect(result.stoppages.map((s) => s.reason)).toEqual(["complete"]);
    expect(executingWrittenAfterGraphComplete).toBe(true);
    const outputs = writes
      .flat()
      .filter((e) => e.type === "node" && e.node.id === "o");
    expect(outputs.at(-1)).toMatchObject({
      node: {
        text: expect.stringContaining("Hello world"),
        cannoliData: { status: "complete" },
      },
    });
  });

  it("persists the entire synchronous non-streaming completion cascade", async () => {
    const latest = new Map<string, PersistorEdit>();
    const persistor: Persistor = {
      async start() {},
      async editNode() {},
      async editEdge() {},
      async addError() {},
      async addWarning() {},
      async editOriginalParallelGroupLabel() {},
      setConfig() {},
      async applyBatch(edits) {
        for (const edit of edits) {
          if (edit.type === "node") latest.set(edit.node.id, edit);
          if (edit.type === "edge") latest.set(edit.edge.id, edit);
        }
      },
    };
    const plain = {
      ...canvas,
      edges: canvas.edges.map((e) => ({ ...e, color: undefined })),
    };
    const result = await runCanvas(plain, {
      isMock: false,
      runArgs: {
        persistor,
        llmConfigs: [{ provider: "ollama", model: "fake" }],
      },
      beforeStart: (run) => {
        run.model = port;
      },
    });
    expect(result.stoppages.map((s) => s.reason)).toEqual(["complete"]);
    for (const id of ["p", "c", "o"])
      expect(latest.get(id)).toMatchObject({
        node: { cannoliData: { status: "complete" } },
      });
    for (const id of ["a", "b"])
      expect(latest.get(id)).toMatchObject({
        edge: { cannoliData: { status: "complete" } },
      });
    expect(latest.get("o")).toMatchObject({ node: { text: "Hello world" } });
  });

  it("reports persistence failure instead of successful completion", async () => {
    const persistor: Persistor = {
      async start() {},
      async editNode() {
        throw new Error("disk full");
      },
      async editEdge() {},
      async addError() {},
      async addWarning() {},
      async editOriginalParallelGroupLabel() {},
      setConfig() {},
    };
    const result = await runCanvas(canvas, {
      isMock: false,
      runArgs: {
        persistor,
        llmConfigs: [{ provider: "ollama", model: "fake" }],
      },
      beforeStart: (run) => {
        run.model = port;
      },
    });
    expect(result.stoppages.map((s) => s.reason)).toEqual(["error"]);
    expect(result.stoppages[0].message).toContain("persist");
  });

  it("stops a stream with partial usage before run-finish and emits nothing afterward", async () => {
    const events = new RunEventBus();
    const seen: RunEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const run = new Run({ cannoli: canvas, events });
    run.model = {
      ...port,
      async *stream() {
        yield { type: "usage", usage };
        yield { type: "text-delta", text: "partial" };
        await new Promise(() => {});
      },
    };
    const stream = await run.callLLMStream(
      { model: "fake", messages: [{ role: "user", content: "hi" }] },
      "c",
    );
    if (typeof stream === "string" || stream instanceof Error)
      throw new Error("expected stream");
    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: "partial" });
    run.stop();
    await iterator.return?.(undefined);
    expect(seen.at(-2)).toMatchObject({ t: "model-finish", usage });
    expect(seen.at(-1)).toMatchObject({
      t: "run-finish",
      status: "stopped",
      usage,
    });
  });

  it("delivers copies, isolates exceptions and unsubscribes", () => {
    const bus = new RunEventBus();
    const seen: RunEvent[] = [];
    bus.subscribe(() => {
      throw new Error("observer failed");
    });
    bus.subscribe((e) => {
      if (e.t === "text-delta") e.text = "changed";
    });
    const off = bus.subscribe((e) => seen.push(e));
    bus.emit({ t: "text-delta", id: "n", callId: "c", text: "original" });
    off();
    off();
    bus.emit({ t: "text-delta", id: "n", callId: "c", text: "ignored" });
    expect(seen).toMatchObject([{ text: "original" }]);
  });

  it("emits Hello world in execution order with node identity and usage", async () => {
    const events = new RunEventBus();
    const seen: RunEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const result = await runCanvas(canvas, {
      isMock: false,
      runArgs: {
        events,
        canvasPath: "Smoke/stream.canvas",
        llmConfigs: [{ provider: "ollama", model: "fake" }],
      },
      beforeStart: (run) => {
        run.model = port;
      },
    });
    expect(result.finished).toBe(true);
    expect(seen[0]).toMatchObject({
      t: "run-start",
      canvasPath: "Smoke/stream.canvas",
    });
    expect(seen.at(-1)).toMatchObject({
      t: "run-finish",
      status: "completed",
      usage,
    });
    const calls = seen.filter((e) =>
      ["model-request", "text-delta", "model-finish"].includes(e.t),
    );
    expect(calls.map((e) => e.t)).toEqual([
      "model-request",
      "text-delta",
      "text-delta",
      "model-finish",
    ]);
    expect(calls.every((e) => "id" in e && e.id === "c")).toBe(true);
    expect(new Set(calls.map((e) => "callId" in e && e.callId)).size).toBe(1);
    expect(
      seen.some((e) => e.t === "node-status" && e.status === "executing"),
    ).toBe(true);
  });

  it("allows a request subscriber to cancel before the provider is invoked", async () => {
    const events = new RunEventBus();
    const seen: RunEvent[] = [];
    let calls = 0;
    const run = new Run({ cannoli: canvas, events });
    run.model = {
      ...port,
      async generate() {
        calls++;
        return port.generate({} as Parameters<ModelPort["generate"]>[0]);
      },
    };
    events.subscribe((e) => {
      seen.push(e);
      if (e.t === "model-request") run.stop();
    });
    await expect(
      run.callLLM({
        model: "fake",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeDefined();
    expect(calls).toBe(0);
    expect(seen.map((e) => e.t)).toEqual([
      "run-start",
      "model-request",
      "model-finish",
      "run-finish",
    ]);
  });

  it("does not initialize persistence after a run-start subscriber stops the run", async () => {
    const events = new RunEventBus();
    let starts = 0;
    const persistor: Persistor = {
      async start() {
        starts++;
      },
      async editNode() {},
      async editEdge() {},
      async addError() {},
      async addWarning() {},
      async editOriginalParallelGroupLabel() {},
      setConfig() {},
    };
    const run = new Run({ cannoli: canvas, events, persistor });
    events.subscribe((e) => {
      if (e.t === "run-start") run.stop();
    });
    await run.start();
    expect(starts).toBe(0);
  });

  it("includes already reported stream usage when a different branch fails", async () => {
    const events = new RunEventBus();
    const seen: RunEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const run = new Run({ cannoli: canvas, events });
    run.model = {
      ...port,
      async *stream() {
        yield { type: "usage", usage };
        yield { type: "text-delta", text: "partial" };
        await new Promise(() => {});
      },
    };
    const stream = await run.callLLMStream(
      { model: "fake", messages: [{ role: "user", content: "hi" }] },
      "c",
    );
    if (typeof stream === "string" || stream instanceof Error)
      throw new Error("expected stream");
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    run.nodeExecutionFailed(run.graph.c, new Error("another branch failed"));
    await iterator.return?.(undefined);
    expect(seen.at(-2)).toMatchObject({ t: "model-finish", usage });
    expect(seen.at(-1)).toMatchObject({
      t: "run-finish",
      status: "error",
      usage,
    });
    expect(run.usage.fake).toMatchObject({
      promptTokens: 3,
      completionTokens: 2,
    });
  });

  it("redacts image URLs in event copies while preserving provider input", async () => {
    const events = new RunEventBus();
    const seen: RunEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const run = new Run({
      cannoli: canvas,
      events,
      secrets: { KEY: "secret-credential" },
    });
    let image = "";
    run.model = {
      ...port,
      async generate(input) {
        image = JSON.stringify(input.messages);
        return { text: "ok", messages: [], finishReason: "stop" };
      },
    };
    await run.callLLM({
      messages: [{ role: "user", content: "image" }],
      imageReferences: [
        {
          messageIndex: 0,
          url: "https://example.test/image?key=secret-credential",
        },
      ],
    });
    expect(image).toContain("secret-credential");
    expect(JSON.stringify(seen)).not.toContain("secret-credential");
    expect(JSON.stringify(seen)).toContain("«secret:KEY»");
    run.stop();
  });

  it("settles and cancels a parallel call before the terminal error event", async () => {
    const events = new RunEventBus();
    const seen: RunEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const branches = {
      nodes: [
        { ...box, id: "a", text: "fail" },
        { ...box, id: "b", text: "slow" },
        { ...box, id: "oa", text: "", color: "6" },
        { ...box, id: "ob", text: "", color: "6" },
      ],
      edges: [
        {
          id: "ea",
          fromNode: "a",
          toNode: "oa",
          fromSide: "right",
          toSide: "left",
        },
        {
          id: "eb",
          fromNode: "b",
          toNode: "ob",
          fromSide: "right",
          toSide: "left",
        },
      ],
    };
    let rejectA: (error: Error) => void = () => {};
    let resolveB: (
      result: Awaited<ReturnType<ModelPort["generate"]>>,
    ) => void = () => {};
    let started = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finished = () => {};
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const signals: AbortSignal[] = [];
    const run = new Run({
      cannoli: branches,
      events,
      llmConfigs: [{ provider: "ollama", model: "fake" }],
      onFinish: () => finished(),
    });
    run.model = {
      ...port,
      generate: (input) =>
        new Promise((resolve, reject) => {
          signals.push(input.signal);
          if (input.messages[0].content === "fail") rejectA = reject;
          else resolveB = resolve;
          if (signals.length === 2) started();
        }),
    };
    await run.start();
    await bothStarted;
    rejectA(new Error("branch failed"));
    await done;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(run.controller.signal.aborted).toBe(false);
    const count = seen.length;
    resolveB({
      text: "late",
      messages: [],
      usage: { inputTokens: 7, outputTokens: 4 },
      finishReason: "stop",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toHaveLength(count);
    expect(seen.at(-1)).toMatchObject({
      t: "run-finish",
      status: "error",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(seen.filter((e) => e.t === "model-finish")).toHaveLength(2);
  });

  it("redacts a credential split across output chunks", async () => {
    const events = new RunEventBus();
    const seen: RunEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const run = new Run({
      cannoli: canvas,
      events,
      secrets: { KEY: "abcabc" },
    });
    run.model = {
      ...port,
      async *stream() {
        yield { type: "text-delta", text: "before abc" };
        yield { type: "text-delta", text: "abc after" };
      },
    };
    const stream = await run.callLLMStream(
      { model: "fake", messages: [{ role: "user", content: "abcabc" }] },
      "c",
    );
    if (typeof stream === "string" || stream instanceof Error)
      throw new Error("expected stream");
    for await (const part of stream) expect(typeof part).toBe("string");
    const text = seen
      .filter(
        (e): e is Extract<RunEvent, { t: "text-delta" }> =>
          e.t === "text-delta",
      )
      .map((e) => e.text)
      .join("");
    expect(text).toBe("before «secret:KEY» after");
    expect(JSON.stringify(seen)).not.toContain("abcabc");
    run.stop();
  });
});
