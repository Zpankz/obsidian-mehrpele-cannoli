// Mock-run golden (DESIGN §14): run every College canvas with isMock and
// snapshot the final canvas, every object's status and the stoppage. Mock runs
// make no model calls, and their choices come from a RNG seeded by the canvas,
// so the same canvas must give the same snapshot every time.
import { describe, expect, it } from "vitest";
import type { Run } from "../../src/run";
import { byId, listFixtures, normaliseObject } from "../helpers/compile";
import { type RunCanvasResult, runCanvas } from "../helpers/run";

const college = listFixtures("college");

// Mock calls still build a request, which needs a provider config. Nothing is
// sent: mock runs never call the provider.
const llmConfigs = [
  {
    provider: "ollama" as const,
    model: "mock-model",
    baseURL: "http://127.0.0.1:9",
  },
];

function mockRun(canvas: unknown): Promise<RunCanvasResult> {
  return runCanvas(canvas, {
    isMock: true,
    timeoutMs: 5000,
    runArgs: { llmConfigs },
  });
}

function statuses(run: Run): Record<string, string> {
  return Object.fromEntries(
    Object.values(run.graph)
      .map((o) => [o.id, o.status] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function snapshotOf({ run, stoppages, finished }: RunCanvasResult): string {
  const canvas = run.canvasData;
  return (
    JSON.stringify(
      {
        finished,
        stoppages: stoppages.map((s) => ({
          reason: s.reason,
          message: s.message,
          results: s.results,
          usage: s.usage,
        })),
        statuses: statuses(run),
        canvas: canvas && {
          nodes: canvas.nodes
            .map((n) =>
              normaliseObject(n as unknown as Record<string, unknown>),
            )
            .sort(byId),
          edges: canvas.edges
            .map((e) =>
              normaliseObject(e as unknown as Record<string, unknown>),
            )
            .sort(byId),
        },
      },
      null,
      2,
    ) + "\n"
  );
}

describe("mock run golden", () => {
  it.each(college.map((f) => [f.name, f] as const))(
    "mock run snapshot stable: %s",
    async (_name, fixture) => {
      const first = snapshotOf(await mockRun(fixture.canvas));
      const second = snapshotOf(await mockRun(fixture.canvas));
      expect(second).toBe(first);
      await expect(first).toMatchFileSnapshot(
        `./__snapshots__/mockrun/${fixture.slug}.json`,
      );
    },
    15_000,
  );
});
