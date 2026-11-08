                                                                                            
import { describe, expect, test } from "bun:test";
import { flowNoteBody, flowNotePath, freePath, needsMehrpele } from "../src/flows/convert-note";

const text = (t: string) => ({ id: t, type: "text", text: t, x: 0, y: 0, width: 100, height: 40 });

describe("flow note name", () => {
  test("`<canvas basename> flow.md` next to the canvas", () => {
    expect(flowNotePath("Flows/Hello world.canvas", () => false)).toBe("Flows/Hello world flow.md");
    expect(flowNotePath("Top.canvas", () => false)).toBe("Top flow.md");
  });

  test("a taken name gets ` 2`, ` 3`…", () => {
    const taken = new Set(["Flows/Hello flow.md", "Flows/Hello flow 2.md"]);
    expect(flowNotePath("Flows/Hello.canvas", (p) => taken.has(p))).toBe("Flows/Hello flow 3.md");
    expect(freePath("A/b flow", ".canvas", (p) => p === "A/b flow.canvas")).toBe("A/b flow 2.canvas");
  });
});

describe("flow note language", () => {
  test("plain labels stay mermaid", () => {
    expect(needsMehrpele({ nodes: [text("Say hello"), text("Summarise")], edges: [] })).toBe(false);
  });

  test("file cards, note references and Markdown labels need mehrpele", () => {
    expect(needsMehrpele({ nodes: [{ id: "f", type: "file", file: "Notes/A.md" }], edges: [] })).toBe(true);
    expect(needsMehrpele({ nodes: [text("{{[[Out]]}}")], edges: [] })).toBe(true);
    expect(needsMehrpele({ nodes: [text("**bold** fact")], edges: [] })).toBe(true);
    expect(needsMehrpele({ nodes: [{ id: "g", type: "group", label: "[[Group]]" }], edges: [] })).toBe(true);
    expect(needsMehrpele({ nodes: [text("a"), text("b")], edges: [{ id: "e", fromNode: "a", toNode: "b", label: "`code`" }] })).toBe(true);
  });


});

describe("flow note body", () => {
  test("a backlink line and a cannoli fence", () => {
    expect(flowNoteBody("Flows/Hello world.canvas", "flowchart LR\n  a --> b\n", "mermaid")).toBe(
      "Converted from [[Flows/Hello world.canvas|Hello world]].\n\n```mermaid cannoli\nflowchart LR\n  a --> b\n```\n",
    );
    expect(flowNoteBody("X.canvas", "flowchart LR", "mehrpele")).toBe("Converted from [[X.canvas|X]].\n\n```mehrpele cannoli\nflowchart LR\n```\n");
  });

  test("a source holding a backtick fence gets a longer one", () => {
    expect(flowNoteBody("X.canvas", 'flowchart LR\n  a["```js"]', "mehrpele")).toBe('Converted from [[X.canvas|X]].\n\n````mehrpele cannoli\nflowchart LR\n  a["```js"]\n````\n');
  });
});
