                                                                                               
import { describe, expect, test } from "bun:test";
import { canonicalJson, confirmFootnote, confirmSections, isConfirmed, referenceSetHash } from "../src/run/confirm";
import { type CanvasDataLike, collectReferences, hostsInText } from "../src/run/references";
import { runCanvas } from "../src/run/runner";
import { fakeApp, fileOf } from "./support/fake-app";
import { fixture, HELLO, openaiSettings, records, runnerHarness } from "./support/runner";

const node = (id: string, type: string, text = "", references: { name: string; type: string; shouldExtract?: boolean }[] = []) => ({
  id,
  cannoliData: { type, text, references },
});
const edge = (fromNode: string, toNode: string, edgeModifier?: string) => ({
  fromNode,
  toNode,
  cannoliData: { type: "basic", ...(edgeModifier ? { edgeModifier } : {}) },
});

const SAMPLE: CanvasDataLike = {
  nodes: [
    node("a", "call", "Summarise {{[[Apple Trees]]}} and {{NOTE}}", [
      { name: "Apple Trees", type: "note" },
      { name: "No current note", type: "note" },
    ]),
    node("b", "reference", "{{[[Summary]]}}", [{ name: "Summary", type: "note" }]),
    node("c", "reference", "{{+@title}}", [{ name: "title", type: "create-note" }]),
    node("d", "call", "{{@picked}} and {{plain}}", [
      { name: "picked", type: "variable", shouldExtract: true },
      { name: "plain", type: "variable", shouldExtract: false },
    ]),
    node("e", "http", "GET https://api.example.org/v1/x?q={{q}}\nPOST https://user@Hooks.Example.com/in"),
    node("f", "http", "https://{{host}}/path"),
    node("g", "content", "folder"),
  ],
  edges: [edge("a", "b"), edge("g", "c", "folder")],
};

describe("reference set", () => {
  test("notes read and written, created notes, dynamic names and HTTP hosts", () => {
    const set = collectReferences(SAMPLE, "api.openai.com");
    expect(set).toEqual({
      providerHost: "api.openai.com",
      notesRead: ["Apple Trees", "Summary"],
      notesWritten: ["Summary"],
      notesCreated: 1,
      createsOutsideFolder: true,
      dynamicNotes: true,
      writesSelection: false,
      httpHosts: ["api.example.org", "hooks.example.com"],
      dynamicHttp: true,
    });
  });

  test("hostsInText strips userinfo and punctuation and flags {{…}} hosts", () => {
    expect(hostsInText("see https://a.example.org/x, and (http://b.example.org:8080).")).toEqual({
      hosts: ["a.example.org", "b.example.org:8080"],
      dynamic: false,
    });
    expect(hostsInText("https://{{h}}.example.org/").dynamic).toBe(true);
  });

  test("the probe of a real canvas lists the note it reads", async () => {
    const { Run } = await import("../src/flows/engine");
    const canvas = JSON.parse(fixture("4. Vault interaction/1. Referencing notes.canvas"));
    const probe = new Run({ cannoli: canvas, isMock: true });
    const set = collectReferences(probe.canvasData as unknown as CanvasDataLike, "api.openai.com");
    expect(set.notesRead).toEqual(["Cannoli College/Example notes/Apple Trees", "Lemons for Cleaning", "Meeting Notes"]);
    expect(set.httpHosts).toEqual([]);
  });

  test("the sections list provider host, notes read, notes written and HTTP hosts", () => {
    const sections = confirmSections(collectReferences(SAMPLE, "api.openai.com"));
    expect(sections.map((s) => s.title)).toEqual(["Model provider", "Notes read", "Notes written", "HTTP hosts"]);
    expect(sections[0].items).toEqual(["api.openai.com"]);
    expect(sections[2].items).toContain("1 new note, in a folder chosen while the flow runs");
    expect(sections[3].items[0]).toBe("api.example.org");
    const empty = confirmSections(collectReferences({ nodes: [], edges: [] }, null));
    expect(empty.map((s) => s.items)).toEqual([["None"], ["None"], ["None"], ["None"]]);
  });

  test("a flow that reads notes says their embedded notes are sent too; the hash ignores it", async () => {
    const set = collectReferences(SAMPLE, "api.openai.com");
    expect(confirmFootnote(confirmSections(set))).toBe("Embedded notes inside these notes are also sent.");
    expect(confirmFootnote(confirmSections(collectReferences({ nodes: [], edges: [] }, null)))).toBeNull();
    // display only: the hash covers the reference set, never the modal text
    expect(canonicalJson(set)).not.toContain("Embedded");
  });
});

describe("hash", () => {
  test("stable for the same set, independent of list order", async () => {
    const a = collectReferences(SAMPLE, "api.openai.com");
    const b = { ...a, notesRead: [...a.notesRead].reverse(), httpHosts: [...a.httpHosts].reverse() };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(await referenceSetHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(await referenceSetHash(a)).toBe(await referenceSetHash(b));
  });

  test("changes when the provider host or the set changes", async () => {
    const a = collectReferences(SAMPLE, "api.openai.com");
    const h = await referenceSetHash(a);
    expect(await referenceSetHash({ ...a, providerHost: "api.anthropic.com" })).not.toBe(h);
    expect(await referenceSetHash({ ...a, notesWritten: [...a.notesWritten, "Other"] })).not.toBe(h);
    expect(await referenceSetHash({ ...a, httpHosts: [] })).not.toBe(h);
    expect(isConfirmed({ "f.canvas": h }, "f.canvas", h)).toBe(true);
    expect(isConfirmed({ "f.canvas": h }, "g.canvas", h)).toBe(false);
  });
});

describe("runner confirmation", () => {
  const FLOW = "Flows/Hello world.canvas";
  const setup = (settings = openaiSettings()) => {
    const fake = fakeApp({ [FLOW]: fixture(HELLO) });
    return { fake, h: runnerHarness(fake, settings) };
  };

  test("asks on the first run, stores the hash, and does not ask again", async () => {
    const { fake, h } = setup();
    const first = await runCanvas(h.deps, fileOf(FLOW), { isMock: true });
    expect(first.status).toBe("complete");
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].flowPath).toBe(FLOW);
    expect(h.prompts[0].sections[0]).toEqual({ title: "Model provider", items: ["api.openai.com"] });
    const saved = JSON.parse(h.host.json!);
    expect(saved.confirmed[FLOW]).toMatch(/^[0-9a-f]{64}$/);

    const second = await runCanvas(h.deps, fileOf(FLOW), { isMock: true });
    expect(second.status).toBe("complete");
    expect(h.prompts).toHaveLength(1);
    const [r1, r2] = records(fake);
    expect(r1.confirmation).toMatchObject({ prompted: true, skipped: false });
    expect(r2.confirmation).toMatchObject({ prompted: false, skipped: false });
  });

  test("asks again when the provider host changes", async () => {
    const { h } = setup();
    await runCanvas(h.deps, fileOf(FLOW), { isMock: true });
    await h.store.update((s) => {
      s.providers.openai = { ...s.providers.openai, baseUrl: "https://proxy.example.org/v1" };
    });
    await runCanvas(h.deps, fileOf(FLOW), { isMock: true });
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1].sections[0].items).toEqual(["proxy.example.org"]);
  });

  test("asks again when the flow's reference set changes", async () => {
    const { fake, h } = setup();
    await runCanvas(h.deps, fileOf(FLOW), { isMock: true });
    const canvas = JSON.parse(fake.files.get(FLOW)!);
    canvas.nodes.find((n: { id: string }) => n.id === "dc3f9351f787531e").text = "Hello {{[[Apple Trees]]}}";
    fake.files.set(FLOW, JSON.stringify(canvas));
    await runCanvas(h.deps, fileOf(FLOW), { isMock: true });
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1].sections[1].items).toEqual(["Apple Trees"]);
  });

  test("declining refuses the run and stores nothing", async () => {
    const { fake, h } = setup();
    h.confirmAnswer = false;
    const out = await runCanvas(h.deps, fileOf(FLOW), { isMock: true });
    expect(out).toMatchObject({ status: "refused", reason: "The run was not confirmed" });
    expect(h.host.json && JSON.parse(h.host.json).confirmed?.[FLOW]).toBeFalsy();
    expect(h.registry.size).toBe(0);
    expect(records(fake)[0]).toMatchObject({ status: "refused", confirmation: { prompted: true, skipped: false } });
  });

  test("skipConfirm runs without a prompt, records what was skipped and stores no hash", async () => {
    const { fake, h } = setup();
    const out = await runCanvas(h.deps, fileOf(FLOW), { isMock: true, skipConfirm: true });
    expect(out.status).toBe("complete");
    expect(h.prompts).toHaveLength(0);
    const rec = records(fake)[0];
    expect(rec.confirmation.prompted).toBe(false);
    expect(rec.confirmation.skipped).toBe(true);
    expect(rec.confirmation.sections.map((s: { title: string }) => s.title)).toEqual([
      "Model provider",
      "Notes read",
      "Notes written",
      "HTTP hosts",
    ]);
    expect(JSON.parse(h.host.json!).confirmed?.[FLOW]).toBeUndefined();
  });

  test("the canvas file is never written", async () => {
    const { fake, h } = setup();
    const before = fake.files.get(FLOW);
    await runCanvas(h.deps, fileOf(FLOW), { isMock: true });
    expect(fake.files.get(FLOW)).toBe(before);
    expect(fake.calls.filter((c) => c.includes(FLOW) && !c.startsWith("cachedRead"))).toEqual([]);
  });
});

describe("new written notes", () => {
  test("missing written notes are marked for display only; the hash ignores whether they exist", async () => {
    const set = collectReferences(SAMPLE, "api.openai.com");
    const plain = confirmSections(set);
    const marked = confirmSections(set, { isMissing: (n) => n === "Summary" });
    expect(marked.find((s) => s.title === "Notes written")!.items[0]).toBe("Summary (new, created next to the flow note)");
    expect(plain.find((s) => s.title === "Notes written")!.items[0]).toBe("Summary");
    // the hash is of the set alone, computed the same way before and after the note exists
    expect(await referenceSetHash(set)).toBe(await referenceSetHash(collectReferences(SAMPLE, "api.openai.com")));
  });

  test("a missing written name with folders is marked as not created", () => {
    const set = { ...collectReferences(SAMPLE, "api.openai.com"), notesWritten: ["Sub/Deep", "Top#H", "A/B#H"] };
    const items = confirmSections(set, { isMissing: () => true }).find((s) => s.title === "Notes written")!.items;
    expect(items.slice(0, 3)).toEqual([
      "Sub/Deep (new; not created: names with folders must exist)",
      "Top#H (new, created next to the flow note)",
      "A/B#H (new; not created: names with folders must exist)",
    ]);
  });
});
