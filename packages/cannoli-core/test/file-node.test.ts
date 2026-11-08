import { describe, expect, it } from "vitest";
import { compileCanvas } from "./helpers/compile";
import { fakeVault, runCanvas } from "./helpers/run";

const box = { x: 0, y: 0, width: 200, height: 100 };

// A file node feeding an output node, as Obsidian saves it: no `text`.
const fileNodeCanvas = (fileNode: Record<string, unknown>) => ({
  nodes: [
    { id: "note", type: "file", ...box, ...fileNode },
    { id: "out", type: "text", text: "", color: "6", ...box, x: 400 },
  ],
  edges: [
    {
      id: "e1",
      fromNode: "note",
      fromSide: "right",
      toNode: "out",
      toSide: "left",
    },
  ],
});

const plainFileNode = fileNodeCanvas({ file: "Folder/Some Note.md" });

describe("file nodes reference their note through `file`", () => {
  it("compiles a plain file node to a note reference without .md", () => {
    const note = compileCanvas(plainFileNode).nodes.find(
      (n) => n.id === "note",
    );
    expect(note?.cannoliData?.type).toBe("reference");
    expect(note?.cannoliData?.references).toEqual([
      { name: "Folder/Some Note", type: "note", shouldExtract: true },
    ]);
  });

  it("prefers `file` over a stale `text`", () => {
    const canvas = fileNodeCanvas({
      file: "Folder/Walking Poem.md",
      text: "{{[[Apple Trees]]}}",
    });
    const note = compileCanvas(canvas).nodes.find((n) => n.id === "note");
    expect(note?.cannoliData?.references).toEqual([
      { name: "Folder/Walking Poem", type: "note", shouldExtract: true },
    ]);
  });

  it("falls back to `text` when `file` is empty", () => {
    const canvas = fileNodeCanvas({ file: "", text: "{{[[Fallback]]}}" });
    const note = compileCanvas(canvas).nodes.find((n) => n.id === "note");
    expect(note?.cannoliData?.references).toEqual([
      { name: "Fallback", type: "note", shouldExtract: true },
    ]);
  });

  it("keeps a note name that has no extension", () => {
    const canvas = fileNodeCanvas({ file: "Apple Trees" });
    const note = compileCanvas(canvas).nodes.find((n) => n.id === "note");
    expect(note?.cannoliData?.references).toEqual([
      { name: "Apple Trees", type: "note", shouldExtract: true },
    ]);
  });

  it("gives a non-note file (image, pdf, plain canvas) no note reference", () => {
    for (const file of ["A/img.png", "A/paper.pdf", "A/board.canvas"]) {
      const note = compileCanvas(fileNodeCanvas({ file })).nodes.find(
        (n) => n.id === "note",
      );
      expect(note?.cannoliData?.references).toEqual([]);
    }
  });

  it("never writes into a non-note file; the run ends with an error", async () => {
    const vault = fakeVault();
    const canvas = {
      nodes: [
        { id: "in", type: "text", text: "hello", color: "6", ...box },
        { id: "img", type: "file", file: "A/img.png", ...box, x: 400 },
      ],
      edges: [
        {
          id: "e1",
          fromNode: "in",
          fromSide: "right",
          toNode: "img",
          toSide: "left",
        },
      ],
    };
    const { finished, stoppages } = await runCanvas(canvas, {
      vault,
      isMock: false,
    });

    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["error"]);
    expect(vault.log.filter((l) => l.startsWith("editNote"))).toEqual([]);
  });

  it("runs a plain file node to completion and reads the note", async () => {
    const vault = fakeVault();
    const { finished, stoppages } = await runCanvas(plainFileNode, {
      vault,
      isMock: false,
    });

    expect(finished).toBe(true);
    expect(stoppages.map((s) => s.reason)).toEqual(["complete"]);
    expect(vault.log).toContain("getNote Folder/Some Note");
  });
});
