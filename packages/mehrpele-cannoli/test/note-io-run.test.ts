                                                                                             
// nodes, so a non-mock run writes to the fake vault without reaching any model.
import { describe, expect, test } from "bun:test";
import { type FlowSource, runFlow } from "../src/run/runner";
import { fakeApp } from "./support/fake-app";
import { FAKE_KEY, openaiSettings, records, runnerHarness } from "./support/runner";

const FLOW = "Flows/flow.md";
const KEY = `${FLOW}#3`;
const OUT = "Flows/Out.md";
const OUT_BODY = "# Out\nIntro.\n\n## Result\nold\n\n## Other\nkeep\n";
const geo = (y: number) => ({ x: 0, y, width: 200, height: 80 });

/** content "Lemon facts" -> `target` (a text or file node). */
const flow = (target: object, source: object = { type: "text", text: "Lemon facts", color: "6" }) => ({
  nodes: [
    { id: "src", ...geo(0), ...source },
    { id: "out", ...geo(200), ...target },
  ],
  edges: [{ id: "e1", fromNode: "src", fromSide: "bottom", toNode: "out", toSide: "top" }],
});

const source = (canvas: object): FlowSource => ({ key: KEY, path: FLOW, name: "flow", frameKey: KEY, read: async () => structuredClone(canvas) });

function setup(init: Record<string, string> = {}) {
  const fake = fakeApp({ [FLOW]: "flow note", ...init });
  fake.secrets.set("mehrpele-flows-key-openai", FAKE_KEY);
  const h = runnerHarness(fake, openaiSettings());
  return { fake, h };
}

describe("note IO through the engine", () => {
  test("a heading-scoped reference writes only that section", async () => {
    const { fake, h } = setup({ [OUT]: OUT_BODY });
    const out = await runFlow(h.deps, source(flow({ type: "text", text: "{{[[Out#Result]]}}", color: "6" })), { skipConfirm: true });
    expect(out).toMatchObject({ status: "complete" });
    expect(fake.files.get(OUT)).toBe("# Out\nIntro.\n\n## Result\nLemon facts\n\n## Other\nkeep\n");
  });

  test("truncated fenced output leaves siblings readable across real engine runs", async () => {
    const { fake, h } = setup({ [OUT]: OUT_BODY });
    const target = { type: "text", text: "{{[[Out#Result]]}}", color: "6" };
    const truncated = flow(target, { type: "text", text: "```js\nunfinished output", color: "6" });
    expect(await runFlow(h.deps, source(truncated))).toMatchObject({ status: "complete" });
    expect(fake.files.get(OUT)).toBe("# Out\nIntro.\n\n## Result\n```js\nunfinished output\n```\n\n## Other\nkeep\n");
    expect(await runFlow(h.deps, source(flow(target)))).toMatchObject({ status: "complete" });
    expect(fake.files.get(OUT)).toBe("# Out\nIntro.\n\n## Result\nLemon facts\n\n## Other\nkeep\n");
  });

  test("a confirmed nested output stays writable on the next real engine run", async () => {
    const { fake, h } = setup();
    const target = { type: "text", text: "{{[[Out#A#B]]}}", color: "6" };
    expect(await runFlow(h.deps, source(flow(target)))).toMatchObject({ status: "complete" });
    expect(fake.files.get(OUT)).toBe("# A\n\n## B\n\nLemon facts");
    expect(await runFlow(h.deps, source(flow(target, { type: "text", text: "second", color: "6" })))).toMatchObject({ status: "complete" });
    expect(fake.files.get(OUT)).toBe("# A\n\n## B\nsecond\n");
    expect(h.prompts).toHaveLength(1);
  });

  test("a file node with a subpath writes only that section", async () => {
    const { fake, h } = setup({ [OUT]: OUT_BODY });
    const out = await runFlow(h.deps, source(flow({ type: "file", file: OUT, subpath: "#Other" })), { skipConfirm: true });
    expect(out).toMatchObject({ status: "complete" });
    expect(fake.files.get(OUT)).toBe("# Out\nIntro.\n\n## Result\nold\n\n## Other\nLemon facts\n");
  });

  test("a missing output note is created next to the flow on a confirmed run, and run 2 does not re-prompt", async () => {
    const { fake, h } = setup();
    const canvas = flow({ type: "text", text: "{{[[New note]]}}", color: "6" });
    expect(await runFlow(h.deps, source(canvas))).toMatchObject({ status: "complete" });
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].sections.find((s) => s.title === "Notes written")!.items).toEqual([
      "New note (new, created next to the flow note)",
    ]);
    expect(fake.files.get("Flows/New note.md")).toBe("Lemon facts");
    expect(fake.calls.filter((c) => c.startsWith("create "))).toEqual(["create Flows/New note.md"]);

    expect(await runFlow(h.deps, source(canvas))).toMatchObject({ status: "complete" });
    expect(h.prompts).toHaveLength(1);
    expect(records(fake).map((r) => r.confirmation.prompted)).toEqual([true, false]);
  });

  test("a missing dotted output file node is listed and created", async () => {
    const { fake, h } = setup();
    const canvas = flow({ type: "file", file: "Daily 2026.11.05" });
    expect(await runFlow(h.deps, source(canvas))).toMatchObject({ status: "complete" });
    expect(h.prompts[0].sections.find((s) => s.title === "Notes written")!.items).toEqual([
      "Daily 2026.11.05 (new, created next to the flow note)",
    ]);
    expect(fake.files.get("Flows/Daily 2026.11.05.md")).toBe("Lemon facts");
  });

  test("a refused confirmation creates nothing", async () => {
    const { fake, h } = setup();
    h.confirmAnswer = false;
    expect(await runFlow(h.deps, source(flow({ type: "text", text: "{{[[New note]]}}", color: "6" })))).toMatchObject({ status: "refused" });
    expect(fake.files.has("Flows/New note.md")).toBe(false);
  });

  test("a pdf file node reaches the engine as link text, with no error and no read", async () => {
    const { fake, h } = setup({ "Papers/x.pdf": "%PDF-binary", [OUT]: "# Out\n" });
    const out = await runFlow(h.deps, source(flow({ type: "text", text: "{{[[Out]]}}", color: "6" }, { type: "file", file: "Papers/x.pdf", subpath: "#page=3" })), {
      skipConfirm: true,
    });
    expect(out).toMatchObject({ status: "complete" });
    expect(fake.files.get(OUT)).toBe("[[Papers/x.pdf#page=3]]");
    expect(fake.calls.some((c) => c.includes("x.pdf"))).toBe(false);
  });

  test("an uncoloured view embed reaches the engine as content link text, with no model call", async () => {
    const fetched: string[] = [];
    const fake = fakeApp({ [FLOW]: "flow note", [OUT]: "# Out\n" });
    fake.secrets.set("mehrpele-flows-key-openai", FAKE_KEY);
    const h = runnerHarness(fake, openaiSettings(), {
      hostFetch: async (input) => {
        fetched.push(String(input));
        throw new Error("no network in tests");
      },
    });
    const out = await runFlow(h.deps, source(flow({ type: "text", text: "{{[[Out]]}}", color: "6" }, { type: "text", text: "![[view:localgraph?depth=1]]" })), {
      skipConfirm: true,
    });
    expect(out).toMatchObject({ status: "complete" });
    expect(fake.files.get(OUT)).toBe("[[view:localgraph?depth=1]]");
    expect(fetched).toEqual([]);
  });
});
