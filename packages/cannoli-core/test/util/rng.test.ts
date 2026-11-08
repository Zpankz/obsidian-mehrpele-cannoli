import { describe, expect, it } from "vitest";
import type { GenericFunctionCall } from "../../src/providers";
import { Run } from "../../src/run";
import { createRng, hashString, seedFromCanvas } from "../../src/util/rng";

const canvas = {
  nodes: [
    { id: "a", type: "text", text: "hi", x: 0, y: 0, width: 10, height: 10 },
  ],
  edges: [],
};

const choiceFunction = (choices: string[]): GenericFunctionCall => ({
  name: "choice",
  parameters: {
    type: "object",
    properties: { choice: { type: "string", enum: choices } },
  },
});

const noteFunction = (notes: string[]): GenericFunctionCall => ({
  name: "note_select",
  parameters: {
    type: "object",
    properties: { note: { type: "string", enum: notes } },
  },
});

const choices = ["a", "b", "c", "d", "e", "f", "g", "h"];

function mockChoices(run: Run, n: number): string[] {
  return Array.from({ length: n }, () => {
    const res = run.createMockChoiceFunctionResponse(choiceFunction(choices));
    return String(res.function_call.args.choice);
  });
}

describe("seeded RNG", () => {
  it("same seed same choices", () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 20 }, a);
    expect(Array.from({ length: 20 }, b)).toEqual(seqA);
    for (const x of seqA) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(Array.from({ length: 20 }, createRng(43))).not.toEqual(seqA);

    // Mock runs pick choices from the run's RNG, so two runs with one seed agree.
    const runA = new Run({ cannoli: canvas, isMock: true, seed: 7 });
    const runB = new Run({ cannoli: canvas, isMock: true, seed: 7 });
    const picked = mockChoices(runA, 30);
    expect(mockChoices(runB, 30)).toEqual(picked);
    expect(new Set(picked).size).toBeGreaterThan(1);
    for (const p of picked) expect(choices).toContain(p);
  });

  it("without a seed, the RNG is seeded from the canvas", () => {
    expect(seedFromCanvas(canvas)).toBe(
      seedFromCanvas(structuredClone(canvas)),
    );
    expect(seedFromCanvas(canvas)).not.toBe(
      seedFromCanvas({ ...canvas, edges: [{ id: "x" }] }),
    );
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));

    const runA = new Run({ cannoli: canvas, isMock: true });
    const runB = new Run({ cannoli: structuredClone(canvas), isMock: true });
    expect(mockChoices(runB, 30)).toEqual(mockChoices(runA, 30));
  });

  it("mock note selection picks a real note", () => {
    const run = new Run({ cannoli: canvas, isMock: true, seed: 1 });
    const notes = ["One", "Two", "Three"];
    for (let i = 0; i < 10; i++) {
      const res = run.createMockNoteNameFunctionResponse(noteFunction(notes));
      // Same shape as the real note_select tool call, which CallNode parses
      // as { note: string }.
      expect(Array.isArray(res.function_call.args)).toBe(false);
      expect(notes).toContain(res.function_call.args.note);
    }
  });
});
