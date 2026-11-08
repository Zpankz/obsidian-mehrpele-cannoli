                                                                                               
import { describe, expect, test } from "bun:test";
import { normaliseForEngine } from "../src/run/normalise";

const geo = { x: 10, y: 20, width: 300, height: 120 };
const canvas = (nodes: object[]) => ({ nodes, edges: [{ id: "e1", fromNode: "a", toNode: "b" }] });

describe("normaliseForEngine", () => {
  test("an md file node with a heading subpath becomes a whole-text reference", () => {
    const input = canvas([{ id: "a", type: "file", file: "Notes/Out.md", subpath: "#Result", color: "4", ...geo }]);
    const out = normaliseForEngine(input) as any;
    expect(out.nodes[0]).toEqual({ id: "a", type: "text", text: "{{[[Notes/Out#Result]]}}", color: "6", ...geo });
    expect(out.edges).toEqual(input.edges);
  });

  test("an extensionless file node with a subpath keeps its path", () => {
    const out = normaliseForEngine(canvas([{ id: "a", type: "file", file: "Out", subpath: "#^blk", ...geo }])) as any;
    expect(out.nodes[0].text).toBe("{{[[Out#^blk]]}}");
  });

  test("an md file node without a subpath is left to the core", () => {
    const node = { id: "a", type: "file", file: "Notes/In.md", ...geo };
    expect((normaliseForEngine(canvas([node])) as any).nodes[0]).toEqual(node);
  });

  test("a non-markdown file node becomes link text, never a reference", () => {
    const out = normaliseForEngine(
      canvas([
        { id: "a", type: "file", file: "Papers/x.pdf", subpath: "#page=3", ...geo },
        { id: "b", type: "file", file: "img/cat.png", color: "4", ...geo },
        { id: "c", type: "file", file: "Flows/other.canvas", ...geo },
      ]),
    ) as any;
    expect(out.nodes.map((n: any) => [n.type, n.text, n.color, n.file, n.subpath])).toEqual([
      ["text", "[[Papers/x.pdf#page=3]]", "6", undefined, undefined],
      ["text", "[[img/cat.png]]", "6", undefined, undefined],
      ["text", "[[Flows/other.canvas]]", "6", undefined, undefined],
    ]);
    expect(out.nodes[0]).toMatchObject({ id: "a", ...geo });
  });

  test("ignored (red, colour 1) file nodes pass through, so the core still skips them", () => {
    const nodes = [
      { id: "a", type: "file", file: "Out.md", subpath: "#Result", color: "1", ...geo },
      { id: "b", type: "file", file: "x.pdf", color: "1", ...geo },
      { id: "c", type: "file", file: "Daily 2026.11.05", color: "1", ...geo },
    ];
    expect((normaliseForEngine(canvas(nodes)) as any).nodes).toEqual(nodes);
  });

  test("a subcannoli (.canvas file, colour 2) stays a file node", () => {
    const node = { id: "a", type: "file", file: "Flows/sub.canvas", color: "2", ...geo };
    expect((normaliseForEngine(canvas([node])) as any).nodes[0]).toEqual(node);
  });

  test("link nodes, view: text and plain text are unchanged", () => {
    const nodes = [
      { id: "a", type: "link", url: "https://example.com", ...geo },
      { id: "b", type: "text", text: "view:Notes/x.pdf#page=2", color: "6", ...geo },
      { id: "c", type: "text", text: "Write one line", ...geo },
      { id: "g", type: "group", label: "G", ...geo },
    ];
    expect((normaliseForEngine(canvas(nodes)) as any).nodes).toEqual(nodes);
  });

  test("dotted note names are notes; only known attachment extensions become link text", () => {
    const out = normaliseForEngine(
      canvas([
        { id: "a", type: "file", file: "Meeting 2026.11", ...geo },
        { id: "b", type: "file", file: "v1.2", subpath: "#H", ...geo },
        { id: "c", type: "file", file: "2026.11.04", ...geo },
        { id: "d", type: "file", file: "x.pdf", ...geo },
        { id: "e", type: "file", file: "img.PNG", ...geo },
      ]),
    ) as any;
    expect(out.nodes.map((n: any) => [n.type, n.text ?? n.file])).toEqual([
                                                                                    
      ["file", "Meeting 2026.11.md"],
      ["text", "{{[[v1.2#H]]}}"],
      ["file", "2026.11.04.md"],
      ["text", "[[x.pdf]]"],
      ["text", "[[img.PNG]]"],
    ]);
  });

  test("an uncoloured view embed becomes a content node of its link text", () => {
    const out = normaliseForEngine(
      canvas([
        { id: "v", type: "text", text: "![[view:localgraph?depth=1]]", ...geo },
        { id: "w", type: "text", text: " ![[view:Notes/x.pdf#page=2|300x200]] ", ...geo },
        { id: "c", type: "text", text: "Describe ![[view:localgraph]] here", ...geo },
      ]),
    ) as any;
    expect(out.nodes[0]).toEqual({ id: "v", type: "text", text: "[[view:localgraph?depth=1]]", color: "6", ...geo });
    expect(out.nodes[1]).toMatchObject({ text: "[[view:Notes/x.pdf#page=2|300x200]]", color: "6" });
    expect(out.nodes[2]).toEqual({ id: "c", type: "text", text: "Describe ![[view:localgraph]] here", ...geo });
  });

  test("the input is not mutated", () => {
    const input = canvas([{ id: "a", type: "file", file: "x.pdf", ...geo }]);
    const before = structuredClone(input);
    normaliseForEngine(input);
    expect(input).toEqual(before);
  });

  test("non-canvas input passes through", () => {
    expect(normaliseForEngine(null)).toBeNull();
    expect(normaliseForEngine({ edges: [] })).toEqual({ edges: [] });
  });
});
