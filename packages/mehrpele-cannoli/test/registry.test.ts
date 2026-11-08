// One run per path; replacing asks first; Stop all flows stops real runs mid-request.
import { afterAll, describe, expect, test } from "bun:test";
import { RunRegistry, type RunHandle } from "../src/run/registry";
import { runCanvas } from "../src/run/runner";
import { fakeApp, fileOf } from "./support/fake-app";
import { startFakeLlm } from "./support/fake-llm";
import { fixture, HELLO, openaiSettings, records, runnerHarness } from "./support/runner";

const FLOW = "Flows/Hello world.canvas";

const handle = (path: string, runId = "r1") => {
  const h = { path, runId, startedAt: 0, stops: 0, stop: () => void h.stops++, done: Promise.resolve({ status: "stopped" as const }) };
  return h;
};

describe("RunRegistry", () => {
  test("add, get, remove by run id, stop and stopAll, with change events", () => {
    const r = new RunRegistry();
    let changes = 0;
    const off = r.onChange(() => changes++);
    const a = handle("a.canvas");
    const b = handle("b.canvas");
    r.add(a);
    r.add(b);
    expect(() => r.add(handle("a.canvas", "r2"))).toThrow("already registered");
    expect(r.size).toBe(2);
    expect(r.get("a.canvas")).toBe(a as unknown as RunHandle);
    r.remove("a.canvas", "other");
    expect(r.has("a.canvas")).toBe(true);
    expect(r.stop("a.canvas")).toBe(true);
    expect(r.stop("zzz.canvas")).toBe(false);
    expect(r.stopAll()).toBe(2);
    expect([a.stops, b.stops]).toEqual([2, 1]);
    r.remove("a.canvas", "r1");
    expect(r.list().map((h) => h.path)).toEqual(["b.canvas"]);
    expect(changes).toBe(3);
    off();
    r.remove("b.canvas", "r1");
    expect(changes).toBe(3);
  });
});

describe("replacing a running flow", () => {
  test("declining keeps the current run and refuses the new one", async () => {
    const fake = fakeApp({ [FLOW]: fixture(HELLO) });
    const h = runnerHarness(fake, openaiSettings());
    const running = handle(FLOW);
    h.registry.add(running as unknown as RunHandle);
    h.replaceAnswer = false;
    const out = await runCanvas(h.deps, fileOf(FLOW), { isMock: true });
    expect(out).toMatchObject({ status: "refused", reason: "A run of this flow is already running" });
    expect(h.replaceAsks).toEqual([FLOW]);
    expect(running.stops).toBe(0);
    expect(h.registry.get(FLOW)).toBe(running as unknown as RunHandle);
    expect(h.engineLoads).toBe(0);
  });

  test("accepting stops the current run, then the new one runs", async () => {
    const fake = fakeApp({ [FLOW]: fixture(HELLO) });
    const h = runnerHarness(fake, openaiSettings());
    const running = handle(FLOW);
    running.stop = () => {
      running.stops++;
      h.registry.remove(FLOW, "r1");
    };
    h.registry.add(running as unknown as RunHandle);
    const out = await runCanvas(h.deps, fileOf(FLOW), { isMock: true });
    expect(running.stops).toBe(1);
    expect(out.status).toBe("complete");
    expect(h.registry.size).toBe(0);
  });
});

describe("two runs of one path started together", () => {
  // Counts engine runs that actually start (the probe Run is constructed but never started).
  function countingEngine() {
    const counter = { starts: 0 };
    const loadEngine = async () => {
      const m = await import("../src/flows/engine");
      class Counting extends m.Run {
        start() {
          counter.starts++;
          return super.start();
        }
      }
      return { ...m, Run: Counting as typeof m.Run };
    };
    return { counter, loadEngine };
  }

  test("declining: exactly one engine run starts, the second is refused", async () => {
    const fake = fakeApp({ [FLOW]: fixture(HELLO) });
    const { counter, loadEngine } = countingEngine();
    const h = runnerHarness(fake, openaiSettings(), { loadEngine });
    h.replaceAnswer = false;
    const first = runCanvas(h.deps, fileOf(FLOW), { isMock: true, skipConfirm: true });
    const second = runCanvas(h.deps, fileOf(FLOW), { isMock: true, skipConfirm: true });
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe("complete");
    expect(b).toMatchObject({ status: "refused", reason: "A run of this flow is already running" });
    expect(h.replaceAsks).toEqual([FLOW]);
    expect(counter.starts).toBe(1);
    expect(records(fake).map((r) => r.status).sort()).toEqual(["complete", "refused"]);
    expect(h.registry.size).toBe(0);
  });

  test("accepting: the first stops before it starts the engine, the second runs", async () => {
    const fake = fakeApp({ [FLOW]: fixture(HELLO) });
    const { counter, loadEngine } = countingEngine();
    const h = runnerHarness(fake, openaiSettings(), { loadEngine });
    const first = runCanvas(h.deps, fileOf(FLOW), { isMock: true, skipConfirm: true });
    const second = runCanvas(h.deps, fileOf(FLOW), { isMock: true, skipConfirm: true });
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe("stopped");
    expect(b.status).toBe("complete");
    expect(counter.starts).toBe(1);
    expect(h.registry.size).toBe(0);
  });

  test("an unexpected throw still writes an error record, frees the path and resolves", async () => {
    const fake = fakeApp({ [FLOW]: fixture(HELLO) });
    const h = runnerHarness(fake, openaiSettings(), {
      onRunStart: () => {
        throw new Error("boom in a listener");
      },
    });
    const out = await runCanvas(h.deps, fileOf(FLOW), { isMock: true, skipConfirm: true });
    expect(out).toMatchObject({ status: "error", reason: "boom in a listener" });
    expect(records(fake)[0]).toMatchObject({ status: "error", reason: "boom in a listener" });
    expect(h.registry.size).toBe(0);
  });
});

describe("stop all flows", () => {
  const server = startFakeLlm({ hang: true });
  afterAll(() => server.stop());

  test("a real run waiting on the provider stops and records 'stopped'", async () => {
    const fake = fakeApp({ [FLOW]: fixture(HELLO) });
    const h = runnerHarness(fake, {
      providers: { openai_compatible: { baseUrl: server.baseUrl, model: "fake-model" } },
      defaultProvider: "openai_compatible",
    });
    h.deps.hostFetch = (input, init) => globalThis.fetch(input, init);
    const pending = runCanvas(h.deps, fileOf(FLOW), { skipConfirm: true });
    const deadline = Date.now() + 5000;
    while (server.hits.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(server.hits.length).toBeGreaterThan(0);
    expect(h.registry.size).toBe(1);
    expect(h.registry.stopAll()).toBe(1);
    const out = await pending;
    expect(out.status).toBe("stopped");
    expect(h.registry.size).toBe(0);
    expect(records(fake)[0]).toMatchObject({ status: "stopped", provider: "openai_compatible", providerHost: `127.0.0.1:${server.port}` });
    expect(h.notices).toContain("Hello world stopped");
  });
});
