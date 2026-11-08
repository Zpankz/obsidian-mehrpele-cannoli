// Cancellation (DESIGN §11.2): a RunController's signal reaches every model
// call and run-path fetch, and stopping keeps what was already streamed.
import { describe, expect, it } from "vitest";
import { CannoliObjectStatus } from "../../src/graph";
import type { Persistor } from "../../src/persistor";
import { LLMProvider, type GenericCompletionParams } from "../../src/providers";
import { Run } from "../../src/run";
import {
  RunController,
  StopError,
  raceAbort,
  withSignal,
} from "../../src/runtime/controller";
import { runCanvas } from "../helpers/run";
import { UsageModel } from "../helpers/usageModel";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves when the signal aborts; never resolves otherwise. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

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
const edge = (
  id: string,
  fromNode: string,
  toNode: string,
  color?: string,
) => ({
  id,
  fromNode,
  fromSide: "right",
  toNode,
  toSide: "left",
  ...(color ? { color } : {}),
});

// prompt → call → output
const oneCall = {
  nodes: [
    text("p", "Write a long story.", 0, 0, "6"),
    text("c", "", 300, 0),
    text("o", "", 600, 0, "6"),
  ],
  edges: [edge("e1", "p", "c"), edge("e2", "c", "o")],
};

// prompt → call ⇒ content, over a green (chat-response) edge, so it streams
const streamingCall = {
  nodes: [
    text("p", "Write a long story.", 0, 0, "6"),
    text("c", "", 300, 0),
    text("o", "", 600, 0, "6"),
  ],
  edges: [edge("e1", "p", "c"), edge("e2", "c", "o", "4")],
};

// an HTTP node (orange) feeding an output node
const httpCall = {
  nodes: [
    text("h", "https://example.test/slow", 0, 0, "2"),
    text("o", "", 300, 0, "6"),
  ],
  edges: [edge("e1", "h", "o")],
};

const request: GenericCompletionParams = {
  messages: [{ role: "user", content: "hi" }],
  model: "fake",
};

interface CallOptions {
  signal?: AbortSignal;
}

/** A provider whose calls hang until their signal aborts. */
function hangingLlm() {
  const seen: { signals: (AbortSignal | undefined)[] } = { signals: [] };
  const llm = {
    initialized: true,
    getMergedConfig: () => ({ model: "fake", provider: "ollama" }),
    async getCompletion(_req: GenericCompletionParams, opts?: CallOptions) {
      seen.signals.push(opts?.signal);
      if (opts?.signal) await aborted(opts.signal);
      else await new Promise(() => {});
      throw new DOMException("The operation was aborted.", "AbortError");
    },
    // Streams a few chunks, then hangs (ignoring the signal) as if the
    // model were still generating.
    async getCompletionStream(
      _req: GenericCompletionParams,
      opts?: CallOptions,
    ) {
      seen.signals.push(opts?.signal);
      async function* chunks() {
        for (const part of ["Once ", "upon ", "a time"]) {
          await sleep(5);
          yield part;
        }
        await new Promise(() => {});
      }
      return chunks();
    },
  };
  return { llm, seen };
}

const stopAfter = (ms: number) => async (run: Run) => {
  await sleep(ms);
  run.stop();
};

describe("controller", () => {
  it("stop aborts in-flight model call", async () => {
    const { llm, seen } = hangingLlm();
    const controller = new RunController();
    const { finished, stoppages, run } = await runCanvas(oneCall, {
      isMock: false,
      runArgs: { controller },
      beforeStart: (r) => {
        r.llm = llm as unknown as Run["llm"];
      },
      afterStart: async () => {
        await sleep(30);
        controller.stop();
      },
    });

    expect(finished).toBe(true);
    expect(seen.signals).toHaveLength(1);
    expect(seen.signals[0]).toBeInstanceOf(AbortSignal);
    expect(seen.signals[0]?.aborted).toBe(true);
    // A user stop, not an error caused by the aborted call.
    expect(stoppages.map((s) => s.reason)).toEqual(["user"]);
    expect(run.graph.c.status).toBe(CannoliObjectStatus.Warning);
  });

  it("stopped run marks executing nodes warning and keeps partial text", async () => {
    const { llm } = hangingLlm();
    const warnings: [string, string][] = [];
    const errors: [string, string][] = [];
    const persistor: Persistor = {
      start: async () => {},
      editNode: async () => {},
      editEdge: async () => {},
      addError: async (id, msg) => {
        errors.push([id, msg]);
      },
      addWarning: async (id, msg) => {
        warnings.push([id, msg]);
      },
      editOriginalParallelGroupLabel: async () => {},
      setConfig: () => {},
    };
    const { finished, stoppages, run } = await runCanvas(streamingCall, {
      isMock: false,
      runArgs: { persistor },
      beforeStart: (r) => {
        r.llm = llm as unknown as Run["llm"];
      },
      afterStart: stopAfter(60),
    });

    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["user"]);
    expect(run.graph.c.status).toBe(CannoliObjectStatus.Warning);
    expect(warnings.map(([id]) => id)).toEqual(["c"]);
    expect(warnings[0][1]).toMatch(/stopped/i);
    expect(errors).toEqual([]);
    // Every streamed chunk is kept, in order, after the assistant header.
    expect(run.graph.o.text).toContain("Once upon a time");
    // The stream never finished, so no "User" template was appended.
    expect(run.graph.o.text).not.toContain("User");
  });

  it("a stream abort frees its pLimit slot", async () => {
    const { llm } = hangingLlm();
    const run = new Run({
      cannoli: oneCall,
      isMock: false,
      config: { pLimit: 1 },
    });
    run.llm = llm as unknown as Run["llm"];

    const stream = await run.callLLMStream(request);
    if (stream instanceof Error || typeof stream === "string") {
      throw new Error(`expected a stream, got ${String(stream)}`);
    }
    // Consume in the background: the stream hangs after three chunks.
    const consumed = (async () => {
      let out = "";
      try {
        for await (const part of stream) out += part;
      } catch {
        // an aborted stream may end by throwing
      }
      return out;
    })();
    await sleep(40);

    run.stop();

    // The one slot is free again: queued work proceeds instead of hanging.
    const fresh = await Promise.race([
      run.llmLimit(async () => "fresh"),
      sleep(500).then(() => "slot still held"),
    ]);
    expect(fresh).toBe("fresh");
    // And the consumer's loop ends with the partial text.
    const out = await Promise.race([consumed, sleep(500).then(() => "hung")]);
    expect(out).toBe("Once upon a time");
  });

  it("provider passes the signal to LangChain", async () => {
    const model = new UsageModel();
    const llm = new LLMProvider({
      configs: [{ provider: "ollama", model: "fake" }],
    });
    llm.getChatClient = () => model;
    const { signal } = new RunController();
    const messages = [{ role: "user", content: "hi" }];

    await llm.getCompletion({ messages }, { signal });
    await llm.getCompletion(
      {
        messages,
        functions: [{ name: "choice", parameters: {} }],
        function_call: { name: "choice" },
      },
      { signal },
    );
    for await (const _ of await llm.getCompletionStream(
      { messages },
      { signal },
    )) {
      // drain
    }

    expect(model.signals).toEqual([signal, signal, signal]);
  });

  it("HttpNode fetch receives the signal", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const { finished, stoppages, run } = await runCanvas(httpCall, {
      isMock: false,
      runArgs: {
        fetcher: async (_url, options) => {
          signals.push(options.signal);
          // Like Obsidian's requestUrl: ignores the signal entirely.
          return new Promise<string>(() => {});
        },
      },
      afterStart: stopAfter(30),
    });

    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["user"]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(true);
    expect(run.graph.h.status).toBe(CannoliObjectStatus.Warning);
  });

  it("a run given an already-stopped controller finishes stopped without running", async () => {
    const { llm, seen } = hangingLlm();
    const controller = new RunController();
    controller.stop();
    const { finished, stoppages } = await runCanvas(oneCall, {
      isMock: false,
      runArgs: { controller },
      beforeStart: (r) => {
        r.llm = llm as unknown as Run["llm"];
      },
    });

    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["user"]);
    expect(seen.signals).toHaveLength(0);
  });

  it("a stop during startup finishes the run once", async () => {
    let release: () => void = () => {};
    const persistor: Persistor = {
      // Startup waits here; the stop lands meanwhile.
      start: () => new Promise<void>((r) => (release = r)),
      editNode: async () => {},
      editEdge: async () => {},
      addError: async () => {},
      addWarning: async () => {},
      editOriginalParallelGroupLabel: async () => {},
      setConfig: () => {},
    };
    const { llm, seen } = hangingLlm();
    const controller = new RunController();
    const stoppages: string[] = [];
    const run = new Run({
      cannoli: structuredClone(oneCall),
      isMock: false,
      persistor,
      controller,
      onFinish: (s) => stoppages.push(s.reason),
    });
    run.llm = llm as unknown as Run["llm"];

    const started = run.start();
    controller.stop();
    release();
    await started;
    await sleep(50);

    expect(stoppages).toEqual(["user"]);
    expect(seen.signals).toHaveLength(0);
  });

  it("a stop while a secret-in-prompt error is saved finishes the run once", async () => {
    let release: () => void = () => {};
    let saving: () => void = () => {};
    const savingError = new Promise<void>((r) => (saving = r));
    const persistor: Persistor = {
      start: async () => {},
      editNode: async () => {},
      editEdge: async () => {},
      // The lint's error write waits here; the stop lands meanwhile.
      addError: () => {
        saving();
        return new Promise<void>((r) => (release = r));
      },
      addWarning: async () => {},
      editOriginalParallelGroupLabel: async () => {},
      setConfig: () => {},
    };
    const canvas = structuredClone(oneCall);
    canvas.nodes[1].text = "Use the key {{MY_SECRET}} now";
    const controller = new RunController();
    const stoppages: string[] = [];
    let resolveFinished = () => {};
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const run = new Run({
      cannoli: canvas,
      isMock: false,
      persistor,
      controller,
      secrets: { MY_SECRET: "fixture-secret-value" },
      onFinish: (s) => {
        stoppages.push(s.reason);
        resolveFinished();
      },
    });

    const started = run.start();
    await savingError;
    controller.stop();
    release();
    await started;
    await finished;

    expect(stoppages).toEqual(["user"]);
  });

  it("a finished run removes its abort listener", async () => {
    const controller = new RunController();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const { signal } = controller;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((
      type: string,
      fn: EventListener,
      o?: unknown,
    ) => {
      if (type === "abort") added.push(fn);
      add(type, fn, o as AddEventListenerOptions);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((
      type: string,
      fn: EventListener,
      o?: unknown,
    ) => {
      if (type === "abort") removed.push(fn);
      remove(type, fn, o as EventListenerOptions);
    }) as typeof signal.removeEventListener;

    const contentOnly = {
      nodes: [text("a", "hello", 0, 0, "6"), text("b", "", 300, 0, "6")],
      edges: [edge("e1", "a", "b")],
    };
    const { finished, stoppages } = await runCanvas(contentOnly, {
      runArgs: { controller },
    });

    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);
    expect(added.length).toBeGreaterThan(0);
    for (const fn of added) expect(removed).toContain(fn);
  });

  it("raceAbort on an aborted signal still handles the promise's rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const controller = new RunController();
      controller.stop();
      const late = Promise.reject(new Error("source saw the abort"));
      await expect(raceAbort(late, controller.signal)).rejects.toBeInstanceOf(
        StopError,
      );
      await sleep(20);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("an action's own fetch signal is kept alongside the run's", async () => {
    const controller = new RunController();
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetcher = withSignal(async (_url: string, options: RequestInit) => {
      signals.push(options.signal);
      return "";
    }, controller.signal);
    const own = new AbortController();
    await fetcher("https://example.test", { signal: own.signal });
    await fetcher("https://example.test");
    own.abort();

    // The action's own signal (e.g. its timeout) still aborts its request...
    expect(signals[0]?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    // ...and a stop aborts both.
    controller.stop();
    expect(signals[1]?.aborted).toBe(true);
  });
});
