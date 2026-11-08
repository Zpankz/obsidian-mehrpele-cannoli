import { beforeEach, describe, expect, test } from "bun:test";
import { IdMap } from "../src/run/idmap";
import { type BadgeState, MIN_EXECUTING_MS, OverlayPersistor, type Scheduler, statusClass } from "../src/run/overlay-persistor";
import { RunViewPersistor } from "../src/run/persistor";

/** Fake clock: frames run on `frame()`, timers on `advance()`. */
class FakeScheduler implements Scheduler {
  t = 0;
  frames: Array<() => void> = [];
  timers: Array<{ at: number; cb: () => void; live: boolean }> = [];
  now = () => this.t;
  frame = (cb: () => void) => {
    this.frames.push(cb);
    return () => (this.frames = this.frames.filter((f) => f !== cb));
  };
  timeout = (cb: () => void, ms: number) => {
    const timer = { at: this.t + ms, cb, live: true };
    this.timers.push(timer);
    return () => (timer.live = false);
  };
  /** Runs pending animation frames (one paint). */
  paint() {
    const fs = this.frames;
    this.frames = [];
    for (const f of fs) f();
  }
  /** Moves the clock, firing due timers in order, painting after each. */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = Math.max(this.t, due.at);
      due.live = false;
      due.cb();
      this.paint();
    }
    this.t = end;
  }
}

const canvas = {
  nodes: [
    { id: "n_A", type: "text", peleId: "A" },
    { id: "n_B", type: "text", peleId: "B" },
    { id: "g_G", type: "group", peleId: "G" },
  ],
  edges: [{ id: "e_A_B_0", fromNode: "n_A", toNode: "n_B" }],
};

let sched: FakeScheduler;
let writes: Array<{ t: number; badges: BadgeState[] }>;
let p: OverlayPersistor;
let view: RunViewPersistor;
const node = (id: string, status: string, text?: string) => ({ id, type: "text", text, cannoliData: { status, text } });
const statusesOf = (id: string) => writes.flatMap((w) => w.badges.filter((b) => b.id === id).map((b) => [w.t, b.status] as const));

beforeEach(() => {
  sched = new FakeScheduler();
  writes = [];
  view = new RunViewPersistor();
  view.seed({ nodes: canvas.nodes });
  p = new OverlayPersistor({ idMap: new IdMap(canvas), scheduler: sched, view, sink: (b) => writes.push({ t: sched.t, badges: b }) });
});

describe("OverlayPersistor", () => {
  test("status maps to an mpc-s-* class", () => {
    expect(statusClass("executing")).toBe("mpc-s-executing");
    expect(statusClass("version-complete")).toBe("mpc-s-version-complete");
  });

  test("changes are coalesced into one write per animation frame", async () => {
    p.seed(canvas);
    await p.editNode(node("n_A", "executing"));
    await p.editNode(node("n_B", "executing"));
    expect(writes).toEqual([]);
    sched.paint();
    expect(writes.length).toBe(1);
    expect(writes[0]!.badges.map((b) => [b.id, b.status])).toEqual([
      ["A", "executing"],
      ["B", "executing"],
      ["G", "pending"],
    ]);
  });

  test("a node stays executing for at least 300 ms", async () => {
    await p.editNode(node("n_A", "executing"));
    sched.paint();
    sched.advance(10);
    await p.editNode(node("n_A", "complete"));
    sched.paint();
    expect(statusesOf("A")).toEqual([[0, "executing"]]);
    sched.advance(400);
    expect(statusesOf("A")).toEqual([
      [0, "executing"],
      [MIN_EXECUTING_MS, "complete"],
    ]);
  });

  test("a node that ran between two frames still shows executing first", async () => {
    await p.editNode(node("n_A", "executing"));
    await p.editNode(node("n_A", "complete"));
    sched.paint();
    sched.advance(1000);
    expect(statusesOf("A")).toEqual([
      [0, "executing"],
      [300, "complete"],
    ]);
  });

  test("at most 4 writes per second per node", async () => {
    const seq = ["pending", "warning", "pending", "warning", "pending", "warning", "pending", "warning", "pending", "warning"];
    for (const s of seq) {
      p.sync({ n_A: { status: s } });
      sched.paint();
      sched.advance(50);
    }
    sched.advance(2000);
    const times = statusesOf("A").map(([t]) => t);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(250);
    expect(times.filter((t) => t < 1000).length).toBeLessThanOrEqual(4);
    // The last state always lands.
    expect(statusesOf("A").at(-1)![1]).toBe("warning");
  });

  test("text previews flush every 250 ms", async () => {
    await p.editNode(node("n_A", "executing", "Hel"));
    sched.paint();
    expect(writes.at(-1)!.badges[0]!.preview).toBe("Hel");
    sched.advance(300);
    await p.editNode(node("n_A", "executing", "Hello"));
    sched.paint();
    await p.editNode(node("n_A", "executing", "Hello wor"));
    sched.paint();
    expect(writes.length).toBe(1);
    sched.advance(250);
    expect(writes.length).toBe(2);
    expect(writes[1]!.badges[0]!.preview).toBe("Hello wor");
  });

  test("errors stick over graph sync and messages are redacted", async () => {
    p.setRedactor((t) => t.replaceAll("fake-key-for-tests-aaaa", "[redacted]"));
    await p.addError("n_B", "bad key fake-key-for-tests-aaaa");
    sched.paint();
    p.sync({ n_B: { status: "complete" } });
    sched.advance(1000);
    const b = p.shown().find((x) => x.id === "B")!;
    expect(b.status).toBe("error");
    expect(b.message).toBe("bad key [redacted]");
    // Teed to the run view, redacted there too.
    expect(view.list().find((r) => r.id === "n_B")).toMatchObject({ status: "error", message: "bad key [redacted]" });
  });

  test("a key longer than the preview is redacted before truncation (start, editNode, run view)", async () => {
    // Review P1: previewOf cut the text to 80 chars first, so a longer key no longer matched the
    // redactor, and start() did not redact at all.
    const key = `fake-key-${"a".repeat(150)}`;
    const redact = (t: string) => t.replaceAll(key, "[redacted]");
    const leaks = (s: string | undefined) => {
      if (!s) return false;
      for (let i = 0; i + 20 <= key.length; i++) if (s.includes(key.slice(i, i + 20))) return true;
      return false;
    };
    p.setRedactor(redact);
    const text = `key ${key} end`;
    view.seed({ nodes: [{ id: "n_A", type: "text", text }] });
    await p.start({ nodes: [{ id: "n_A", type: "text", text, cannoliData: { status: "pending", text } }] });
    sched.paint();
    expect(p.shown().find((b) => b.id === "A")!.preview).toBe("key [redacted] end");
    await p.editNode(node("n_A", "executing", `now ${key}`));
    sched.advance(1000);
    for (const w of writes) for (const b of w.badges) expect(leaks(b.preview) || leaks(b.message)).toBe(false);
    expect(p.shown().find((b) => b.id === "A")!.preview).toBe("now [redacted]");
    for (const r of view.list()) expect(leaks(r.label)).toBe(false);
  });

  test("graph sync drives the overlay (mock runs skip persistor calls)", () => {
    p.sync({ n_A: { status: "complete" }, e_A_B_0: { status: "complete" }, "n_B-1": { status: "executing" } });
    sched.paint();
    expect(writes[0]!.badges.map((b) => [b.id, b.kind, b.status])).toEqual([
      ["A", "node", "complete"],
      ["L_A_B_0", "edge", "complete"],
      ["B", "node", "executing"],
    ]);
    expect(view.list().find((r) => r.id === "n_A")!.status).toBe("complete");
  });

  test("copies share a badge; executing beats complete", () => {
    p.sync({ "n_A-0": { status: "complete" }, "n_A-1": { status: "executing" } });
    sched.paint();
    expect(p.shown()).toEqual([{ id: "A", kind: "node", status: "executing" }]);
  });

  test("unknown ids are counted and surfaced as a warning", () => {
    p.sync({ ghost: { status: "complete" }, "other-1": { status: "pending" } });
    sched.paint();
    expect(writes).toEqual([]);
    expect(p.unknownCount).toBe(2);
    expect(p.warnings()).toEqual(["2 run objects could not be placed on the diagram (ghost, other-1)."]);
  });

  test("flush writes now; dispose stops all writes", async () => {
    await p.editNode(node("n_A", "executing"));
    sched.paint();
    await p.editNode(node("n_A", "complete"));
    p.flush();
    expect(statusesOf("A")).toEqual([
      [0, "executing"],
      [0, "complete"],
    ]);
    p.dispose();
    await p.editNode(node("n_B", "complete"));
    sched.paint();
    sched.advance(1000);
    expect(writes.length).toBe(2);
  });

  test("at run end a node that ran between frames flashes executing, then lands on its final status", async () => {
    // Live repro (C4 L1 b): the output node went executing -> complete between two frames, the run
    // ended, and end() ran flush() then dispose(): flush wrote the owed executing flash, dispose
    // dropped the follow-up write, and the badge stayed executing (pulsing) for good.
    p.seed(canvas);
    sched.paint();
    await p.editNode(node("n_B", "executing"));
    await p.editNode(node("n_B", "complete"));
    let settled = false;
    p.flush();
    p.settle(() => {
      settled = true;
      p.dispose();
    });
    expect(settled).toBe(false);
    sched.paint();
    sched.advance(1000);
    expect(settled).toBe(true);
    expect(statusesOf("B")).toEqual([
      [0, "pending"],
      [0, "executing"],
      [MIN_EXECUTING_MS, "complete"],
    ]);
  });

  test("a dry run seen only through sync (pending -> complete) still flashes executing", () => {
    // Live repro (C4 L1 f): a mock run ends in ~4 ms and the core skips persistor calls, so the
                                                                                     
    p.seed(canvas);
    p.sync({ n_A: { status: "complete" }, n_B: { status: "rejected" } });
    p.flush();
    p.settle(() => p.dispose());
    sched.paint();
    sched.advance(1000);
    expect(statusesOf("A")).toEqual([
      [0, "executing"],
      [MIN_EXECUTING_MS, "complete"],
    ]);
    // A node that did not run does not pretend it did.
    expect(statusesOf("B")).toEqual([[0, "rejected"]]);
  });

  test("a stopped run turns badges still executing back to pending", async () => {
    p.seed(canvas);
    sched.paint();
    await p.editNode(node("n_A", "executing"));
    sched.advance(400);
    await p.editNode(node("n_B", "executing")); // never shown before the stop
    p.unfinished();
    p.flush();
    p.settle(() => p.dispose());
    sched.paint();
    sched.advance(1000);
    expect(statusesOf("A")).toEqual([
      [0, "pending"],
      [250, "executing"],
      [400, "pending"],
    ]);
    expect(statusesOf("B").at(-1)![1]).toBe("pending");
    expect(statusesOf("B").map(([, st]) => st)).not.toContain("executing");
  });

  test("for-each copies replace the seeded original's pending part (group and member)", () => {
    // The factory removes the original for-each group and members and runs only the -n copies,
                                                                                        
    p.seed(canvas);
    p.sync({ "g_G-0": { status: "complete" }, "g_G-1": { status: "complete" }, "n_A-0": { status: "complete" }, "n_A-1": { status: "complete" } });
    p.flush();
    p.settle(() => p.dispose());
    sched.paint();
    sched.advance(1000);
    const final = Object.fromEntries(p.shown().map((b) => [b.id, b.status]));
    expect(final).toMatchObject({ A: "complete", G: "complete", B: "pending" });
  });

  test("for-each copies: one executing and one complete shows executing", () => {
    p.seed(canvas);
    p.sync({ "n_A-0": { status: "executing" }, "n_A-1": { status: "complete" } });
    p.flush();
    expect(p.shown().find((b) => b.id === "A")!.status).toBe("executing");
  });

  test("an original that the run graph does report keeps its own part", () => {
    p.seed(canvas);
    p.sync({ "n_A-0": { status: "complete" }, n_A: { status: "executing" } });
    p.flush();
    expect(p.shown().find((b) => b.id === "A")!.status).toBe("executing");
  });

  test("settle calls back at once when nothing is queued", async () => {
    await p.editNode(node("n_A", "complete"));
    sched.paint();
    sched.advance(1000);
    let settled = false;
    p.settle(() => (settled = true));
    expect(settled).toBe(true);
  });
});

describe("event-driven overlay", () => {
  test("batched persistence cannot revert status events or force an early UI flush", async () => {
    p.seed(canvas);
    p.onEvent({ t: "node-status", id: "n_A", status: "executing" as never, at: 1 });
    p.onEvent({ t: "node-status", id: "n_A", status: "complete" as never, at: 2 });
    await p.asPersistor().editNode(node("n_A", "pending", "accepted output"));
    p.sync({ n_A: { status: "pending" } });
    expect("flush" in p.asPersistor()).toBe(false);
    p.flush();
    expect(statusesOf("A").at(-1)?.[1]).toBe("executing");
    sched.advance(MIN_EXECUTING_MS);
    expect(statusesOf("A").at(-1)?.[1]).toBe("complete");
    expect(p.shown().find(b => b.id === "A")?.preview).toBe("accepted output");
  });
  test("stream previews accumulate per call and late events after disposal do nothing", async () => {
    p.onEvent({ t: "text-delta", id: "n_A", callId: "first", text: "Hello " });
    p.onEvent({ t: "text-delta", id: "n_A", callId: "first", text: "world" });
    p.onEvent({ t: "node-status", id: "n_A", status: "executing" as never, at: 1 });
    await p.asPersistor().editNode(node("n_A", "executing", "stale prompt snapshot"));
    sched.paint();
    expect(p.shown().find(b => b.id === "A")?.preview).toBe("Hello world");
    p.onEvent({ t: "text-delta", id: "n_A", callId: "other", text: "Separate" });
    sched.advance(250);
    expect(p.shown().find(b => b.id === "A")?.preview).toBe("Separate");
    const before = writes.length;
    p.dispose();
    p.onEvent({ t: "text-delta", id: "n_A", callId: "other", text: " late" });
    sched.advance(1000);
    sched.paint();
    expect(writes.length).toBe(before);
  });
});
