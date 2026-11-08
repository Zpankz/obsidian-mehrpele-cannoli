                                                                                                
// frameKey, sourceHash and lint, stop reasons land in the record and the notice.
import { describe, expect, test } from "bun:test";
import type { RunViewPersistor } from "../src/run/persistor";
import { type FlowSource, runFlow } from "../src/run/runner";
import { fakeApp } from "./support/fake-app";
import { fixture, HELLO, openaiSettings, records, runnerHarness } from "./support/runner";

const NOTE = "Notes/Hello world.md";
const KEY = `${NOTE}#4`;

function frameSource(over: Partial<FlowSource> = {}): FlowSource {
  return {
    key: KEY,
    path: NOTE,
    name: "Hello world",
    frameKey: KEY,
    sourceHash: "00000000abcdef",
    read: async () => JSON.parse(fixture(HELLO)),
    ...over,
  };
}

describe("runFlow (frame sources)", () => {
  test("ignores the Cannoli lock and records frameKey, sourceHash and lint", async () => {
    const fake = fakeApp({});
    fake.app.plugins.plugins.cannoli = { runningCannolis: { "Hello world": {} } };
    const h = runnerHarness(fake, openaiSettings());
    const lint = [{ level: "warning" as const, code: "dropped" as const, message: "1 item was dropped." }];
    const out = await runFlow(h.deps, frameSource({ lint }), { isMock: true, skipConfirm: true });
    expect(out.status).toBe("complete");
    expect(records(fake)[0]).toMatchObject({ flowPath: NOTE, frameKey: KEY, sourceHash: "00000000abcdef", lint, status: "complete" });
    expect(h.registry.has(KEY)).toBe(false);
  });

  test("confirmations are stored per frame key", async () => {
    const fake = fakeApp({});
    const h = runnerHarness(fake, openaiSettings());
    await runFlow(h.deps, frameSource(), { isMock: true });
    expect(h.prompts.map((p) => p.flowPath)).toEqual([KEY]);
    expect(Object.keys((await h.store.get()).confirmed)).toEqual([KEY]);
    await runFlow(h.deps, frameSource(), { isMock: true });
    expect(h.prompts).toHaveLength(1);
    await runFlow(h.deps, frameSource({ key: `${NOTE}#20`, frameKey: `${NOTE}#20` }), { isMock: true });
    expect(h.prompts).toHaveLength(2);
  });

  test("a blocked source is refused before the engine loads", async () => {
    const fake = fakeApp({});
    const h = runnerHarness(fake, openaiSettings());
    const reason = "A sequence diagram cannot run as a flow. Use a flowchart or a state diagram.";
    const out = await runFlow(h.deps, frameSource({ blocked: reason, lint: [{ level: "error", code: "unsupported", message: reason }] }), {
      isMock: true,
    });
    expect(out).toMatchObject({ status: "refused", reason });
    expect(h.engineLoads).toBe(0);
    expect(h.notices).toEqual([reason]);
    expect(records(fake)[0]).toMatchObject({ status: "refused", reason, frameKey: KEY, lint: [{ code: "unsupported" }] });
  });

  test("a stop reason lands in the stopped record and the notice", async () => {
    const fake = fakeApp({});
    const reason = "Flow source changed, run stopped";
    const h = runnerHarness(fake, openaiSettings(), {
      onRunStart: (run) => run.handle.stop(reason),
    });
    const out = await runFlow(h.deps, frameSource(), { isMock: true, skipConfirm: true });
    expect(out).toMatchObject({ status: "stopped", reason });
    expect(h.notices).toEqual([reason]);
    expect(records(fake)[0]).toMatchObject({ status: "stopped", reason, frameKey: KEY });
  });

  test("a frame read error is an error record", async () => {
    const fake = fakeApp({});
    const h = runnerHarness(fake, openaiSettings());
    const out = await runFlow(
      h.deps,
      frameSource({
        read: async () => {
          throw new Error("no host");
        },
      }),
      { isMock: true },
    );
    expect(out).toMatchObject({ status: "error", reason: "Could not read the flow: no host" });
    expect(h.notices).toEqual(["Could not read Hello world: no host"]);
  });

  test("the attachment gets the persistor calls, every sync and the end status", async () => {
    const fake = fakeApp({});
    const h = runnerHarness(fake, openaiSettings());
    const seen = { attached: 0, syncs: 0, end: "" as string, view: null as RunViewPersistor | null };
    const out = await runFlow(
      h.deps,
      frameSource({
        attach: (view) => {
          seen.attached++;
          seen.view = view;
          return { persistor: view, sync: (g) => (seen.syncs++, view.sync(g)), end: (s) => (seen.end = s) };
        },
      }),
      { isMock: true, skipConfirm: true },
    );
    expect(out.status).toBe("complete");
    expect(seen.attached).toBe(1);
    expect(seen.syncs).toBeGreaterThanOrEqual(1);
    expect(seen.end).toBe("complete");
    expect(seen.view!.list().length).toBeGreaterThan(0);
  });

  test("the confirmation covers the note an obsidianCurrentNote arg names for {{NOTE}}", async () => {
    // A call node writes into a {{NOTE}} content-reference node: the arg picks which note.
    const noteFlow = {
      nodes: [
        { id: "ask", type: "text", text: "Write one line about lemons", x: 0, y: 0, width: 200, height: 60 },
        { id: "out", type: "text", text: "{{NOTE}}", color: "6", x: 0, y: 200, width: 200, height: 60 },
      ],
      edges: [{ id: "e1", fromNode: "ask", fromSide: "bottom", toNode: "out", toSide: "top" }],
    };
    const fake = fakeApp({ "Notes/Target A.md": "a", "Notes/Target B.md": "b" });
    const h = runnerHarness(fake, openaiSettings());
    const src = (note: string) => frameSource({ read: async () => structuredClone(noteFlow), args: { obsidianCurrentNote: note } });
    const items = (i: number, title: string) => h.prompts[i].sections.find((s) => s.title === title)?.items;

    await runFlow(h.deps, src("Notes/Target A"), { isMock: true });
    expect(h.prompts).toHaveLength(1);
    expect(items(0, "Notes read")).toEqual(["Notes/Target A"]);
    expect(items(0, "Notes written")).toEqual(["Notes/Target A"]);
    const firstHash = (await h.store.get()).confirmed[KEY];

    // A different note: a different reference set and hash, so the user is asked again.
    await runFlow(h.deps, src("Notes/Target B"), { isMock: true });
    expect(h.prompts).toHaveLength(2);
    expect(items(1, "Notes written")).toEqual(["Notes/Target B"]);
    expect((await h.store.get()).confirmed[KEY]).not.toBe(firstHash);
  });
});
