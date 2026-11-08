                                                                             
import { describe, expect, test } from "bun:test";
import { semanticKey } from "../src/flows/semantic";
import type { Translation } from "../src/flows/translate";

const translation = (edge: object): Translation =>
  ({
    type: "flowchart",
    config: {},
    canvas: {
      nodes: [
        { id: "a", type: "text", text: "A", x: 0, y: 0, width: 10, height: 10 },
        { id: "b", type: "text", text: "B", x: 50, y: 0, width: 10, height: 10 },
      ],
      edges: [{ id: "e1", fromNode: "a", toNode: "b", ...edge }],
    },
  }) as unknown as Translation;

describe("semanticKey", () => {
  test("an edge's arrow ends are part of the key (core isValidEdge reads them)", () => {
    const base = semanticKey(translation({}));
    expect(semanticKey(translation({ toEnd: "arrow" }))).toBe(semanticKey(translation({ toEnd: "arrow" })));
    expect(semanticKey(translation({ toEnd: "none" }))).not.toBe(base);
    expect(semanticKey(translation({ fromEnd: "arrow" }))).not.toBe(base);
    expect(semanticKey(translation({ fromEnd: "arrow", toEnd: "none" }))).not.toBe(semanticKey(translation({ toEnd: "none" })));
  });

  test("edge order is part of the key (core takes the first incoming write edge)", () => {
    const two = (edges: object[]) =>
      semanticKey({ ...translation({}), canvas: { ...translation({}).canvas, edges } } as Translation);
    const e1 = { id: "e1", fromNode: "a", toNode: "b" };
    const e2 = { id: "e2", fromNode: "b", toNode: "a" };
    expect(two([e1, e2])).not.toBe(two([e2, e1]));
  });

  test("edge ids and geometry stay out of the key", () => {
    expect(semanticKey(translation({ id: "other" }))).toBe(semanticKey(translation({})));
  });
});
