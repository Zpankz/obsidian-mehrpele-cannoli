import { afterEach, describe, expect, it, vi } from "vitest";
import { CannoliObjectStatus as Status } from "../../src/graph";
import type { Persistor, PersistorEdit } from "../../src/persistor";
import type { AllVerifiedCannoliCanvasNodeData } from "../../src/graph";
import { BatchedPersistor } from "../../src/runtime/batched-persistor";

const node = (text: string, status = Status.Executing) =>
  ({
    id: "n",
    type: "text",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    text,
    cannoliData: { status },
  }) as AllVerifiedCannoliCanvasNodeData;
function sink() {
  const writes: { at: number; edits: readonly PersistorEdit[] }[] = [];
  const target: Persistor = {
    async start() {},
    async editNode(n) {
      writes.push({ at: Date.now(), edits: [{ type: "node", node: n }] });
    },
    async editEdge() {},
    async addError() {},
    async addWarning() {},
    async editOriginalParallelGroupLabel() {},
    setConfig() {},
    async applyBatch(edits) {
      writes.push({ at: Date.now(), edits: structuredClone(edits) });
    },
  };
  return { writes, target, batch: new BatchedPersistor(target) };
}
afterEach(() => vi.useRealTimers());

describe("BatchedPersistor", () => {
  it("100 text deltas in 1s produce at most five writes and keep final text", async () => {
    vi.useFakeTimers();
    const { writes, batch } = sink();
    for (let i = 0; i < 100; i++) {
      await batch.editNode(node(String(i)));
      await vi.advanceTimersByTimeAsync(10);
    }
    await batch.flush();
    expect(writes.length).toBeLessThanOrEqual(5);
    expect(writes.at(-1)?.edits).toMatchObject([{ node: { text: "99" } }]);
  });

  it("coalesces per-chunk execute/complete churn on chat output nodes", async () => {
    vi.useFakeTimers();
    const { writes, batch } = sink();
    for (let i = 0; i < 100; i++) {
      await batch.editNode(node(String(i), Status.Executing));
      await batch.editNode(node(String(i), Status.Complete));
      await vi.advanceTimersByTimeAsync(10);
    }
    await batch.flush();
    expect(writes.length).toBeLessThanOrEqual(5);
    expect(writes.at(-1)?.edits).toMatchObject([
      { node: { text: "99", cannoliData: { status: "complete" } } },
    ]);
  });

  it("keeps text deadlines independent of unrelated urgent status writes", async () => {
    vi.useFakeTimers();
    const { writes, batch } = sink();
    await batch.editNode({ ...node("0"), id: "stream" });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i <= 10; i++) {
      await vi.advanceTimersByTimeAsync(100);
      await batch.editNode({ ...node(String(i)), id: "stream" });
      await batch.editNode({
        ...node(String(i), i % 2 ? Status.Pending : Status.Complete),
        id: "other",
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    const stream = writes.filter((w) =>
      w.edits.some((e) => e.type === "node" && e.node.id === "stream"),
    );
    expect(stream.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < stream.length; i++)
      expect(stream[i].at - stream[i - 1].at).toBeLessThanOrEqual(250);
    await batch.flush();
  });

  it("preserves different diagnostics for the same node while coalescing duplicates", async () => {
    const { batch, writes } = sink();
    await batch.addWarning("n", "first missing note");
    await batch.addWarning("n", "second missing note");
    await batch.addWarning("n", "first missing note");
    await batch.addError("n", "first error");
    await batch.addError("n", "second error");
    await batch.flush();
    expect(writes.flatMap((w) => w.edits)).toHaveLength(4);
  });

  it("status changes coalesce and flush next tick", async () => {
    vi.useFakeTimers();
    const { writes, batch } = sink();
    await batch.editNode(node("a"));
    await batch.editNode(node("b"));
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].edits).toMatchObject([{ node: { text: "b" } }]);
  });

  it("paints executing for 300ms even when the graph completes in one tick", async () => {
    vi.useFakeTimers();
    const { writes, batch } = sink();
    await batch.editNode(node("running"));
    await batch.editNode(node("complete", Status.Complete));
    const finished = batch.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].edits).toMatchObject([
      { node: { cannoliData: { status: "executing" } } },
    ]);
    await vi.advanceTimersByTimeAsync(299);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await finished;
    expect(writes).toHaveLength(2);
    expect(writes[1].at - writes[0].at).toBeGreaterThanOrEqual(300);
    expect(writes[1].edits).toMatchObject([
      { node: { text: "complete", cannoliData: { status: "complete" } } },
    ]);
  });

  it("final flush persists edits made during a slow write", async () => {
    const { writes, batch, target } = sink();
    const apply = target.applyBatch!;
    target.applyBatch = async (edits) => {
      if (!writes.length) await batch.editNode(node("newer", Status.Pending));
      await apply(edits);
    };
    await batch.editNode(node("first", Status.Pending));
    await batch.flush();
    expect(writes.at(-1)?.edits).toMatchObject([{ node: { text: "newer" } }]);
  });

  it("waits only for paints with pending edits when flushing several nodes", async () => {
    vi.useFakeTimers();
    const { batch, writes } = sink();
    await batch.editNode(node("first"));
    await vi.advanceTimersByTimeAsync(400);
    await batch.editNode({ ...node("second"), id: "other" });
    await batch.editNode({ ...node("finished", Status.Complete), id: "other" });
    const flushed = batch.flush();
    await vi.advanceTimersByTimeAsync(300);
    await flushed;
    expect(writes.at(-1)?.edits).toMatchObject([
      { node: { id: "other", text: "finished" } },
    ]);
  });

  it("reports a failed timer write through flush without unhandled rejections", async () => {
    vi.useFakeTimers();
    const { target, batch } = sink();
    target.applyBatch = async () => {
      throw new Error("disk full");
    };
    await batch.editNode(node("x"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(batch.flush()).rejects.toThrow("disk full");
  });

  it("supports legacy persistors and snapshots mutable callers", async () => {
    const { target, writes, batch } = sink();
    delete target.applyBatch;
    const n = node("saved", Status.Pending);
    await batch.editNode(n);
    n.text = "mutated";
    await batch.flush();
    expect(writes[0].edits).toMatchObject([{ node: { text: "saved" } }]);
  });
});
