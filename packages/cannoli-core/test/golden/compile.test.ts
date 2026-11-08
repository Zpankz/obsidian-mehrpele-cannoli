import { describe, expect, it } from "vitest";
import {
  type CanvasFixture,
  compileCanvas,
  hydrateGraph,
  listFixtures,
} from "../helpers/compile";
import { runCanvas } from "../helpers/run";

const college = listFixtures("college");
const smoke = listFixtures("smoke");

type Node = Record<string, unknown> & { id: string };
type Edge = Record<string, unknown> & { id: string };

const textNode = (id: string, text: string, color?: string): Node => ({
  id,
  type: "text",
  text,
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ...(color ? { color } : {}),
});

const edge = (
  id: string,
  fromNode: string,
  toNode: string,
  extra: Record<string, unknown> = {},
): Edge => ({
  id,
  fromNode,
  fromSide: "right",
  toNode,
  toSide: "left",
  ...extra,
});

const nodeType = (
  compiled: ReturnType<typeof compileCanvas>,
  id: string,
): unknown => compiled.nodes.find((n) => n.id === id)?.cannoliData?.type;

describe("compiles every College canvas without throwing", () => {
  it("finds the 36 College canvases", () => {
    expect(college).toHaveLength(36);
  });

  it.each(college.map((f) => [f.name, f] as const))("%s", (_name, fixture) => {
    const compiled = compileCanvas(fixture.canvas);
    expect(compiled.nodes.length).toBeGreaterThan(0);
    // The run builds a CannoliGraph straight after compiling; that must not throw either.
    expect(() => hydrateGraph(fixture.canvas)).not.toThrow();
  });
});

describe("compile snapshot stable", () => {
  const all: CanvasFixture[] = [...college, ...smoke];

  it.each(all.map((f) => [f.name, f] as const))(
    "compile snapshot stable: %s",
    async (_name, fixture) => {
      const compiled = compileCanvas(fixture.canvas);
      await expect(
        JSON.stringify(compiled, null, 2) + "\n",
      ).toMatchFileSnapshot(`./__snapshots__/compile/${fixture.slug}.json`);
    },
  );

  it("compiling twice gives the same result and does not mutate the input", () => {
    for (const fixture of all) {
      const before = JSON.stringify(fixture.canvas);
      expect(compileCanvas(fixture.canvas)).toEqual(
        compileCanvas(fixture.canvas),
      );
      expect(JSON.stringify(fixture.canvas)).toBe(before);
    }
  });
});

it("red nodes and edges are ignored", () => {
  const canvas = {
    nodes: [
      textNode("in", "Say hi", "6"),
      textNode("call", ""),
      textNode("out", "", "6"),
      // Floating format, so only the red check drops it: an uncoloured
      // "[x]" node would compile as a floating variable.
      textNode("redNode", "[x]\nfoo", "1"),
    ],
    edges: [
      edge("e1", "in", "call"),
      edge("e2", "call", "out"),
      edge("redEdge", "in", "out", { color: "1" }),
    ],
  };

  const compiled = compileCanvas(canvas);

  expect(compiled.nodes.map((n) => n.id)).toEqual(["call", "in", "out"]);
  expect(compiled.nodes.find((n) => n.id === "redNode")).toBeUndefined();
  expect(compiled.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
  expect(nodeType(compiled, "in")).toBe("input");
  expect(nodeType(compiled, "call")).toBe("standard-call");
  expect(nodeType(compiled, "out")).toBe("output");
  expect(() => hydrateGraph(canvas)).not.toThrow();
});

// An uncoloured arrow out of a red node used to survive compilation with a
// dependency on the dropped node (and isReflexive: true), so CannoliGraph
// hydration threw "Cannot read properties of undefined (reading
// 'addEventListener')". Fixed in P0.4 (g).
it("edges from a red node are dropped with it (P0.4 (g))", () => {
  const canvas = {
    nodes: [
      textNode("in", "Say hi", "6"),
      textNode("call", ""),
      textNode("out", "", "6"),
      textNode("redNode", "ignored call", "1"),
    ],
    edges: [
      edge("e1", "in", "call"),
      edge("e2", "call", "out"),
      edge("fromRed", "redNode", "out"),
    ],
  };

  expect(compileCanvas(canvas).edges.map((e) => e.id)).toEqual(["e1", "e2"]);
  expect(() => hydrateGraph(canvas)).not.toThrow();
});

it("edges into a red node are dropped with it", () => {
  const canvas = {
    nodes: [
      textNode("in", "Say hi", "6"),
      textNode("call", ""),
      textNode("out", "", "6"),
      textNode("redNode", "", "1"),
    ],
    edges: [
      edge("e1", "in", "call"),
      edge("e2", "call", "out"),
      edge("toRed", "call", "redNode"),
    ],
  };

  expect(compileCanvas(canvas).edges.map((e) => e.id)).toEqual(["e1", "e2"]);
  expect(() => hydrateGraph(canvas)).not.toThrow();
});

// P0.4 (h): nested parallel groups duplicate the inner group first, then the
// outer group duplicates those copies, so second-level copies pointed their
// originalObject at a first-level copy ("x-0") that is gone from the final graph.
describe("nested parallel group copies", () => {
  const box = (id: string, x: number, y: number, w: number, h: number) => ({
    id,
    x,
    y,
    width: w,
    height: h,
  });
  // A list feeds the outer group (2 items); inside it, a 3-item list feeds the
  // inner group, whose call node therefore runs 2 × 3 = 6 times.
  const nested = {
    nodes: [
      {
        ...box("outer", 0, 0, 1000, 1000),
        type: "group",
        label: "2",
        color: "5",
      },
      {
        ...box("inner", 100, 300, 600, 600),
        type: "group",
        label: "3",
        color: "5",
      },
      {
        ...box("sub", 100, 50, 200, 100),
        type: "text",
        text: "- x\n- y\n- z",
        color: "6",
      },
      {
        ...box("call", 200, 400, 200, 100),
        type: "text",
        text: "Describe {{item}} {{subitem}}",
      },
      {
        ...box("list", -400, 0, 200, 100),
        type: "text",
        text: "- a\n- b",
        color: "6",
      },
      {
        ...box("out", 1200, 400, 200, 100),
        type: "text",
        text: "",
        color: "6",
      },
    ],
    edges: [
      edge("eList", "list", "outer", { label: "item", color: "5" }),
      edge("eSub", "sub", "inner", { label: "subitem", color: "5" }),
      edge("eOut", "call", "out", { label: "-" }),
    ],
  };

  it("point originalObject at the object on the canvas", () => {
    const compiled = compileCanvas(nested);
    const canvasIds = new Set([
      ...nested.nodes.map((n) => n.id),
      ...nested.edges.map((e) => e.id),
    ]);
    const all = [...compiled.nodes, ...compiled.edges];
    const originals = all.map((o) => [o.id, o.cannoliData?.originalObject]);

    // 2 outer copies × 3 inner copies of the call node.
    const callCopies = originals.filter(([id]) =>
      String(id).startsWith("call-"),
    );
    expect(callCopies).toHaveLength(6);
    for (const [id, original] of originals) {
      if (original == null) continue;
      expect(canvasIds.has(String(original)), `${id} -> ${original}`).toBe(
        true,
      );
    }
    expect(Object.fromEntries(callCopies)).toEqual({
      "call-0-0": "call",
      "call-0-1": "call",
      "call-1-0": "call",
      "call-1-1": "call",
      "call-2-0": "call",
      "call-2-1": "call",
    });
    const innerCopies = originals.filter(([id]) =>
      /^inner-\d-\d$/.test(String(id)),
    );
    expect(innerCopies.map(([, o]) => o)).toEqual(Array(6).fill("inner"));
    const outerCopies = originals.filter(([id]) =>
      /^outer-\d$/.test(String(id)),
    );
    expect(outerCopies.map(([, o]) => o)).toEqual(["outer", "outer"]);
  });

  it("parallel group labels count every copy of the canvas group", async () => {
    // Content-only, so a real (non-mock) run needs no model and exercises the persistor.
    const labels: Record<string, string> = {};
    const persistor = {
      start: async () => {},
      editNode: async () => {},
      editEdge: async () => {},
      addError: async () => {},
      addWarning: async () => {},
      editOriginalParallelGroupLabel: async (id: string, label: string) => {
        labels[id] = label;
      },
      setConfig: () => {},
    };
    const contentOnly = structuredClone(nested);
    const call = contentOnly.nodes.find((n) => n.id === "call") as {
      color?: string;
    };
    call.color = "6";

    const { finished, stoppages } = await runCanvas(contentOnly, {
      isMock: false,
      runArgs: { persistor },
    });

    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);
    expect(labels).toEqual({ inner: "6/6", outer: "2/2" });
  });
});

// P0.4 (i) ruling: blank, uncoloured edges touching a group keep the types their
// endpoints give them. Upstream once meant them to be chat edges, but that check
// never ran (P0.2 removed it); turning it on would change existing canvases.
it("blank edges touching a group keep their endpoint-based types", () => {
  const group = {
    id: "g",
    type: "group",
    label: "G",
    x: 300,
    y: -50,
    width: 400,
    height: 400,
  };
  const canvas = {
    nodes: [
      group,
      { ...textNode("inner", ""), x: 350, y: 0 },
      { ...textNode("content", "Some text", "6"), x: -400 },
      { ...textNode("call", ""), x: -400, y: 300 },
      { ...textNode("out", "", "6"), x: 900 },
      { ...textNode("next", ""), x: 900, y: 300 },
    ],
    edges: [
      edge("contentToGroup", "content", "g"),
      edge("callToGroup", "call", "g"),
      edge("groupToContent", "g", "out"),
      edge("groupToCall", "g", "next"),
    ],
  };

  const types = Object.fromEntries(
    compileCanvas(canvas).edges.map((e) => [e.id, e.cannoliData?.type]),
  );
  expect(types).toEqual({
    contentToGroup: "system-message",
    callToGroup: "chat",
    groupToContent: "write",
    groupToCall: "chat",
  });
});

it("contentIsColorless swaps call/content", () => {
  const canvas = {
    nodes: [textNode("plain", "Say hi"), textNode("purple", "", "6")],
    edges: [edge("e1", "plain", "purple")],
  };

  const normal = compileCanvas(canvas);
  expect(nodeType(normal, "plain")).toBe("standard-call");
  expect(nodeType(normal, "purple")).toBe("output");

  const swapped = compileCanvas(canvas, { contentIsColorless: true });
  expect(nodeType(swapped, "plain")).toBe("input");
  expect(nodeType(swapped, "purple")).toBe("standard-call");
});
