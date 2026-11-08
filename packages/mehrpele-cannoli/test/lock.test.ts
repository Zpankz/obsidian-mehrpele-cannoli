                                                                                      
import { describe, expect, test } from "bun:test";
import { cannoliIsRunning, LOCK_NOTICE } from "../src/run/lock";
import { NO_PROVIDER_NOTICE, runCanvas } from "../src/run/runner";
import { fakeApp, fileOf } from "./support/fake-app";
import { fixture, HELLO, openaiSettings, records, runnerHarness } from "./support/runner";

const FLOW = "Flows/Hello world.canvas";

describe("cannoliIsRunning", () => {
  test("keys on runningCannolis[basename]", () => {
    const app = { plugins: { plugins: { cannoli: { runningCannolis: { "Hello world": {} } } } } };
    expect(cannoliIsRunning(app, fileOf(FLOW))).toBe(true);
    expect(cannoliIsRunning(app, fileOf("Flows/Other.canvas"))).toBe(false);
    expect(cannoliIsRunning({ plugins: { plugins: { cannoli: {} } } }, fileOf(FLOW))).toBe(false);
    expect(cannoliIsRunning({ plugins: { plugins: {} } }, fileOf(FLOW))).toBe(false);
    expect(cannoliIsRunning({}, fileOf(FLOW))).toBe(false);
  });
});

describe("runner lock", () => {
  test("refuses with the exact notice, loads no engine and never touches the canvas", async () => {
    const fake = fakeApp({ [FLOW]: fixture(HELLO) });
    fake.app.plugins.plugins.cannoli = { runningCannolis: { "Hello world": { stop() {} } } };
    const h = runnerHarness(fake, openaiSettings());
    const before = fake.files.get(FLOW);
    const out = await runCanvas(h.deps, fileOf(FLOW), { isMock: true });
    expect(out.status).toBe("refused");
    expect(out.reason).toBe(LOCK_NOTICE);
    expect(out.recordPath).toMatch(/^\.mehrpele-cannoli\/runs\/\d{4}-\d{2}-\d{2}\/\d{8}T\d{6}Z-[0-9a-z]{4}\.json$/);
    expect(h.notices).toEqual(["Cannoli is already running this canvas"]);
    expect(h.engineLoads).toBe(0);
    expect(h.prompts).toHaveLength(0);
    expect(fake.files.get(FLOW)).toBe(before);
    expect(fake.calls.filter((c) => c.includes(FLOW))).toEqual([]);
    expect(records(fake)[0]).toMatchObject({ status: "refused", reason: LOCK_NOTICE, flowPath: FLOW });
  });

  test("another canvas still runs while Cannoli runs this one", async () => {
    const fake = fakeApp({ [FLOW]: fixture(HELLO), "Flows/Other.canvas": fixture(HELLO) });
    fake.app.plugins.plugins.cannoli = { runningCannolis: { "Hello world": {} } };
    const h = runnerHarness(fake, openaiSettings());
    const out = await runCanvas(h.deps, fileOf("Flows/Other.canvas"), { isMock: true });
    expect(out.status).toBe("complete");
  });

  test("no provider: a clear notice, no run", async () => {
    const fake = fakeApp({ [FLOW]: fixture(HELLO) });
    const h = runnerHarness(fake, null);
    const out = await runCanvas(h.deps, fileOf(FLOW), { isMock: true });
    expect(out).toMatchObject({ status: "refused", reason: NO_PROVIDER_NOTICE });
    expect(h.notices).toEqual([NO_PROVIDER_NOTICE]);
    expect(h.engineLoads).toBe(1);
    expect(fake.calls.filter((c) => c.startsWith("cachedRead"))).toEqual([`cachedRead ${FLOW}`]);
  });
});
