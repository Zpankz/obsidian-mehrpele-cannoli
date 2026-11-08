                                                                                                
// and processFrontMatter, creates only where confirmed, and never deletes, moves or renames.
import { describe, expect, test } from "bun:test";
import { linkpathOf, MOCK_NOTE_BODY, toYaml, VaultFileManager, writeSection } from "../src/run/vault-file-manager";
import { fakeApp } from "./support/fake-app";

const NOTE = "Notes/Apple Trees.md";
const BODY = "---\ntags: [fruit]\n---\n# Apple Trees\nThey grow.\n\n## Pruning\nIn winter.\n\n## Picking\nIn autumn.\n";

const setup = (opts: Partial<ConstructorParameters<typeof VaultFileManager>[1]> = {}, init: Record<string, string> = {}) => {
  const fake = fakeApp({ [NOTE]: BODY, "Flows/f.canvas": "{}", ...init });
  const vfm = new VaultFileManager(fake.app, { flowFolder: "Flows", allowCreateOutsideFolder: false, ...opts });
  return { fake, vfm };
};
const FORBIDDEN = ["modify", "delete", "trash", "rename"];
const noForbidden = (calls: string[]) => expect(calls.filter((c) => FORBIDDEN.includes(c))).toEqual([]);

describe("reads", () => {
  test("getNote uses cachedRead and strips front matter unless asked", async () => {
    const { fake, vfm } = setup();
    expect(await vfm.getNote({ name: "Apple Trees" }, false)).toBe(BODY.replace(/^---[\s\S]*?---\n/, ""));
    expect(await vfm.getNote({ name: "[[Apple Trees|alias]]", includeProperties: true }, false)).toBe(BODY);
    expect(await vfm.getNote({ name: "Apple Trees", includeName: true, includeLink: true }, false)).toStartWith(
      "# Apple Trees\n[[Notes/Apple Trees.md|Apple Trees]]\n\n# Apple Trees",
    );
    expect(await vfm.getNote({ name: "Missing" }, false)).toBeNull();
    expect(fake.calls.every((c) => c === `cachedRead ${NOTE}`)).toBe(true);
  });

  test("a vault path ending in .md resolves too", async () => {
    const { vfm } = setup();
    expect(await vfm.getNotePath("Notes/Apple Trees.md")).toBe(NOTE);
    expect(await vfm.getNotePath("Apple Trees")).toBe(NOTE);
    expect(linkpathOf("[[A/B|c]]")).toBe("A/B");
  });

  test("heading subpaths fall back to a text match without a metadata cache", async () => {
    const { vfm } = setup();
    expect(await vfm.getNote({ name: "Apple Trees", subpath: "Pruning" }, false)).toBe("## Pruning\nIn winter.");
    expect(await vfm.getNote({ name: "Apple Trees", subpath: "Nope" }, false)).toBeNull();
  });

  test("resolveSubpath is used when a cache exists", async () => {
    const { fake, vfm } = setup({ resolveSubpath: () => ({ start: { line: 6 }, end: { line: 8 } }) });
    (fake.app.metadataCache as any).getFileCache = () => ({});
    expect(await vfm.getNote({ name: "Apple Trees", subpath: "Pruning" }, false)).toBe("## Pruning\nIn winter.");
  });

  test("embeds are inlined as quotes", async () => {
    const { vfm } = setup({}, { "Notes/Outer.md": "Before\n![[Apple Trees#Picking]]\nAfter" });
    expect(await vfm.getNote({ name: "Outer" }, false)).toBe("Before\n> ## Picking\n> In autumn.\nAfter");
  });

  test("front matter is read from the metadata cache, never through processFrontMatter", async () => {
    for (const mock of [false, true]) {
      const { fake, vfm } = setup({ mock }, { "Notes/Outer.md": "No properties." });
      fake.frontmatter.set(NOTE, { tags: ["fruit"], title: "Apples" });
      expect(await vfm.getPropertyOfNote("Apple Trees", "title")).toBe("Apples");
      expect(await vfm.getPropertyOfNote("Apple Trees", "tags", true)).toBe("- fruit");
      expect(await vfm.getAllPropertiesOfNote("Apple Trees")).toBe(JSON.stringify({ tags: ["fruit"], title: "Apples" }, null, 2));
      expect(await vfm.getPropertyOfNote("Missing", "x")).toBeNull();
      // a note without front matter reads as {} (as upstream's processFrontMatter read did)
      expect(await vfm.getAllPropertiesOfNote("Outer")).toBe("{}");
      expect(fake.calls).toEqual([]);
      expect(fake.frontmatter.get(NOTE)).toEqual({ tags: ["fruit"], title: "Apples" });
    }
    expect(toYaml({ a: "x: y", b: [1, 2] })).toBe('a: "x: y"\nb:\n  - 1\n  - 2');
  });

  test("a property the note does not have reads as null, never the text \"null\"", async () => {
    // upstream 2.3.3: yaml.dump(undefined) throws and is caught (null); JSON.stringify gives undefined
    const { fake, vfm } = setup();
    fake.frontmatter.set(NOTE, { title: "Apples" });
    expect(await vfm.getPropertyOfNote("Apple Trees", "Date", true)).toBeNull();
    expect(await vfm.getPropertyOfNote("Apple Trees", "Date")).toBeNull();
    expect(await vfm.getPropertyOfNote("Apple Trees", "title", true)).toBe("Apples");
  });
});

describe("writes", () => {
  test("editNote goes through vault.process and keeps front matter", async () => {
    const { fake, vfm } = setup();
    await vfm.editNote({ name: "Apple Trees" }, "New body", false);
    expect(fake.files.get(NOTE)).toBe("---\ntags: [fruit]\n---\nNew body");
    await vfm.editNote({ name: "Apple Trees" }, "\nmore", false, true);
    expect(fake.files.get(NOTE)).toBe("---\ntags: [fruit]\n---\nNew body\nmore");
    await vfm.editNote({ name: "Apple Trees", includeProperties: true }, "all", false);
    expect(fake.files.get(NOTE)).toBe("all");
    expect(await vfm.editNote({ name: "Missing" }, "x", false)).toBeNull();
    expect(fake.calls.filter((c) => c.startsWith("process"))).toHaveLength(3);
    noForbidden(fake.calls);
  });

  test("editPropertyOfNote uses processFrontMatter and parses lists", async () => {
    const { fake, vfm } = setup();
    await vfm.editPropertyOfNote("Apple Trees", "tags", "- a\n- b");
    await vfm.editPropertyOfNote("Apple Trees", "title", "T");
    expect(fake.frontmatter.get(NOTE)).toEqual({ tags: ["a", "b"], title: "T" });
    expect(fake.files.get(NOTE)).toBe(BODY);
  });

  test("moveNote throws and nothing is ever deleted, renamed, trashed or modified", async () => {
    const { fake, vfm } = setup();
    await expect(vfm.moveNote("[[Apple Trees]]", "Elsewhere")).rejects.toThrow('never moves or renames notes (asked to move "Apple Trees")');
    expect(fake.files.get(NOTE)).toBe(BODY);
    noForbidden(fake.calls);
  });
});

describe("creating", () => {
  test("no folder means the flow's folder; duplicates get a number", async () => {
    const { fake, vfm } = setup({}, { "Flows/Idea.md": "x" });
    expect(await vfm.createNoteAtExistingPath("Idea", undefined, "c")).toBe("[[Flows/Idea 1.md|Idea 1]]");
    expect(fake.files.get("Flows/Idea 1.md")).toBe("c");
    expect(await vfm.createNoteAtExistingPath("Idea", "Flows/Sub")).toBe("[[Flows/Sub/Idea 2.md|Idea 2]]");
    expect(await vfm.createNoteAtNewPath("New", "Flows/Deep")).toBe("[[Flows/Deep/New.md|New]]");
    expect(await vfm.createFolder("Flows/Out")).toBe(true);
    expect(await vfm.createFolder("Flows/Out")).toBe(false);
  });

  test("outside the flow's folder is refused unless the confirmation listed it", async () => {
    const { fake, vfm } = setup();
    await expect(vfm.createNoteAtExistingPath("X", "Elsewhere")).rejects.toThrow('"Elsewhere" was not part of this flow');
    await expect(vfm.createNoteAtNewPath("X", "")).rejects.toThrow('"/" was not part');
    await expect(vfm.createFolder("FlowsX")).rejects.toThrow("not part of this flow's confirmation");
    expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual([]);

    const allowed = setup({ allowCreateOutsideFolder: true });
    expect(await allowed.vfm.createNoteAtNewPath("X", "Elsewhere", "b")).toBe("[[Elsewhere/X.md|X]]");
    expect(allowed.fake.files.get("Elsewhere/X.md")).toBe("b");
  });

  test("path escapes are refused for every create, even when outside creates were confirmed", async () => {
    for (const allowCreateOutsideFolder of [false, true]) {
      const { fake, vfm } = setup({ allowCreateOutsideFolder });
      const refused = async (p: Promise<unknown>, why: string) => expect(p).rejects.toThrow(why);
      // ".." and "." segments, in the folder or in the note name
      await refused(vfm.createNoteAtNewPath("X", "Flows/../Elsewhere"), '"." and ".."');
      await refused(vfm.createNoteAtNewPath("../../outside", "Flows"), '"." and ".."');
      await refused(vfm.createNoteAtExistingPath("X", "Flows/./Sub"), '"." and ".."');
      await refused(vfm.createNoteAtExistingPath("../X"), '"." and ".."');
      await refused(vfm.createNoteAtExistingPath("X", "Flows/.. /up"), '"." and ".."');
      await refused(vfm.createFolder("Flows/.."), '"." and ".."');
      // absolute paths, drive prefixes and backslashes
      await refused(vfm.createNoteAtExistingPath("X", "/etc"), "relative to the vault");
      await refused(vfm.createNoteAtNewPath("X", "C:/Users"), "relative to the vault");
      await refused(vfm.createNoteAtNewPath("X", "Flows\\..\\..\\x"), "backslashes");
      // the config folder, in any case
      await refused(vfm.createNoteAtNewPath("main", ".obsidian/plugins/evil"), "config folder");
      await refused(vfm.createNoteAtExistingPath("X", ".Obsidian/snippets"), "config folder");
      await refused(vfm.createFolder(".obsidian/plugins/evil"), "config folder");
      expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual([]);
    }
  });

  test("a note name with folders is checked as the full path, not just the folder", async () => {
    const { fake, vfm } = setup({ flowFolder: "" });
    await expect(vfm.createNoteAtExistingPath(".obsidian/plugins/x/main")).rejects.toThrow("config folder");
    await expect(vfm.createNoteAtExistingPath("Sub/Note")).rejects.toThrow('"Sub" was not part of this flow');
    const mock = setup({ mock: true });
    await expect(mock.vfm.createNoteAtNewPath("X", "Flows/../..")).rejects.toThrow('"." and ".."');
    expect([...fake.calls, ...mock.fake.calls]).toEqual([]);
  });

  test("edits refuse a note that resolves into the config folder", async () => {
    const CFG = ".obsidian/snippets/theme.md";
    const { fake, vfm } = setup({}, { [CFG]: "body" });
    await expect(vfm.editNote({ name: CFG }, "x", false)).rejects.toThrow("config folder");
    await expect(vfm.editPropertyOfNote(CFG, "p", "v")).rejects.toThrow("config folder");
    expect(fake.files.get(CFG)).toBe("body");
    expect(fake.calls.filter((c) => c.startsWith("process"))).toEqual([]);
  });

  test("a flow at the vault root may create at the root only", async () => {
    const { vfm } = setup({ flowFolder: "" });
    expect(await vfm.createNoteAtExistingPath("Root note")).toBe("[[Root note.md|Root note]]");
    await expect(vfm.createNoteAtNewPath("X", "Sub")).rejects.toThrow("not part of this flow");
  });
});

describe("mock runs", () => {
  test("no reads and no writes", async () => {
    const { fake, vfm } = setup({ mock: true });
    expect(await vfm.getNote({ name: "Apple Trees" }, false)).toBe(`# Apple Trees\n${MOCK_NOTE_BODY}`);
    await vfm.editNote({ name: "Apple Trees" }, "x", false);
    await vfm.editPropertyOfNote("Apple Trees", "p", "v");
    expect(await vfm.createNoteAtExistingPath("New")).toBe("[[Flows/New.md|New]]");
    expect(await vfm.createFolder("Flows/F")).toBe(true);
    vfm.editSelection("x", false);
    expect(fake.calls).toEqual([]);
    expect(fake.files.get(NOTE)).toBe(BODY);
  });

  test("the engine's own isMock flag also suppresses writes", async () => {
    const { fake, vfm } = setup();
    expect(await vfm.getNote({ name: "Apple Trees" }, true)).toContain(MOCK_NOTE_BODY);
    await vfm.editNote({ name: "Apple Trees" }, "x", true);
    expect(fake.calls).toEqual([]);
  });
});

                          
const OUT = "Flows/Out.md";
const OUT_BODY = "---\nk: v\n---\n# Out\nIntro.\n\n## Result\nold\n\n### Detail\nnested\n\n## Other\nkeep\n";

describe("heading-scoped writes", () => {
  test("replace touches only the section, nested headings included; front matter and siblings kept", async () => {
    const { fake, vfm } = setup({}, { [OUT]: OUT_BODY });
    expect(await vfm.editNote({ name: "Out", subpath: "#Result" }, "new", false)).toBeUndefined();
    expect(fake.files.get(OUT)).toBe("---\nk: v\n---\n# Out\nIntro.\n\n## Result\nnew\n\n## Other\nkeep\n");
    noForbidden(fake.calls);
  });

  test("append adds at the end of the section", async () => {
    const { fake, vfm } = setup({}, { [OUT]: OUT_BODY });
    await vfm.editNote({ name: "Out", subpath: "Result" }, "more", false, true);
    expect(fake.files.get(OUT)).toBe("---\nk: v\n---\n# Out\nIntro.\n\n## Result\nold\n\n### Detail\nnested\nmore\n\n## Other\nkeep\n");
  });

  test("a section at the end of the note", async () => {
    const { fake, vfm } = setup({}, { [OUT]: OUT_BODY });
    await vfm.editNote({ name: "Out", subpath: "Other" }, "last", false);
    expect(fake.files.get(OUT)).toBe("---\nk: v\n---\n# Out\nIntro.\n\n## Result\nold\n\n### Detail\nnested\n\n## Other\nlast\n");
  });

  test("Name#Heading in the name is split when there is no subpath", async () => {
    const { fake, vfm } = setup({}, { [OUT]: OUT_BODY });
    await vfm.editNote({ name: "[[Out#Result]]" }, "split", false);
    expect(fake.files.get(OUT)).toContain("## Result\nsplit\n\n## Other\nkeep\n");
    expect(await vfm.getNote({ name: "Out#Other" }, false)).toBe("## Other\nkeep");
  });

  test("a heading the note does not have, or a block subpath, is not writable", async () => {
    const { fake, vfm } = setup({}, { [OUT]: OUT_BODY });
    expect(await vfm.editNote({ name: "Out", subpath: "Missing" }, "x", false)).toBeNull();
    expect(await vfm.editNote({ name: "Out#^blk" }, "x", false)).toBeNull();
    expect(fake.files.get(OUT)).toBe(OUT_BODY);
    expect(fake.calls.filter((c) => c.startsWith("create"))).toEqual([]);
  });

  test("the write is computed from process's own data, so a concurrent change survives", async () => {
    const { fake, vfm } = setup({}, { [OUT]: OUT_BODY });
    const process = fake.app.vault.process;
    fake.app.vault.process = async (f, fn) => {
      // another writer lands between any earlier read and this write
      fake.files.set(OUT, fake.files.get(OUT)!.replace("keep", "edited elsewhere"));
      return process(f, fn);
    };
    await vfm.getNote({ name: "Out" }, false);
    await vfm.editNote({ name: "Out", subpath: "Result" }, "new", false);
    expect(fake.files.get(OUT)).toBe("---\nk: v\n---\n# Out\nIntro.\n\n## Result\nnew\n\n## Other\nedited elsewhere\n");
    expect(fake.calls.filter((c) => c.startsWith("process"))).toEqual([`process ${OUT}`]);
    noForbidden(fake.calls);
  });

  test("heading-looking lines inside code fences do not end a section", async () => {
    const body = "## Result\nold\n```\n## not a heading\n```\n## Other\nkeep\n";
    const { fake, vfm } = setup({}, { [OUT]: body });
    await vfm.editNote({ name: "Out#Result" }, "new", false);
    expect(fake.files.get(OUT)).toBe("## Result\nnew\n\n## Other\nkeep\n");
  });
});

describe("link text", () => {
  const init = { "Papers/x.pdf": "%PDF-binary", "img/cat.png": "PNG" };
  test("non-markdown targets read as their link text with no IO", async () => {
    const { fake, vfm } = setup({}, init);
    expect(await vfm.getNote({ name: "x.pdf", subpath: "page=3" }, false)).toBe("x.pdf#page=3");
    expect(await vfm.getNote({ name: "https://example.com/a#frag" }, false)).toBe("https://example.com/a#frag");
    expect(await vfm.getNote({ name: "view:Notes/x" }, false)).toBe("view:Notes/x");
    expect(await vfm.getNote({ name: "missing.webm" }, false)).toBe("missing.webm");
    expect(fake.calls).toEqual([]);
  });

  test("a name that resolves to a non-markdown file is link text too", async () => {
    const { fake, vfm } = setup({}, { "Papers/Report.pdf": "%PDF" });
    (fake.app.metadataCache as any).getFirstLinkpathDest = (l: string) => (l === "Report" ? { path: "Papers/Report.pdf", basename: "Report", extension: "pdf" } : null);
    expect(await vfm.getNote({ name: "Report" }, false)).toBe("Report");
    expect(await vfm.editNote({ name: "Report" }, "x", false)).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  test("editNote on link text is not writable", async () => {
    const { fake, vfm } = setup({ creatable: ["x.pdf", "https://e.com"] }, init);
    expect(await vfm.editNote({ name: "x.pdf" }, "x", false)).toBeNull();
    expect(await vfm.editNote({ name: "https://e.com" }, "x", false)).toBeNull();
    expect(await vfm.editNote({ name: "view:x" }, "x", false)).toBeNull();
    expect(fake.calls).toEqual([]);
    noForbidden(fake.calls);
  });

  test("an embedded pdf in a note is left as written", async () => {
    const { vfm } = setup({}, { ...init, "Notes/Outer.md": "See ![[x.pdf#page=3]] here" });
    expect(await vfm.getNote({ name: "Outer" }, false)).toBe("See ![[x.pdf#page=3]] here");
  });

  test("links resolve against the flow note's path", async () => {
    const seen: string[] = [];
    const { fake, vfm } = setup({ sourcePath: "Flows/flow.md" });
    const real = fake.app.metadataCache.getFirstLinkpathDest;
    fake.app.metadataCache.getFirstLinkpathDest = (l, s) => (seen.push(s), real(l, s));
    await vfm.getNote({ name: "Apple Trees" }, false);
    await vfm.getCanvas("f.canvas", false);
    await vfm.getFile("f.canvas", false);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["Flows/flow.md"]));
  });
});

describe("create-on-first-write", () => {
  test("a missing note in the confirmed set is created next to the flow", async () => {
    const written: string[] = [];
    const { fake, vfm } = setup({ creatable: ["Out", "Log#Today"], onWrite: (n) => written.push(n) });
    expect(await vfm.editNote({ name: "Out" }, "first", false)).toBeUndefined();
    expect(fake.files.get("Flows/Out.md")).toBe("first");
    expect(await vfm.editNote({ name: "Log#Today" }, "entry", false)).toBeUndefined();
    expect(fake.files.get("Flows/Log.md")).toBe("# Today\n\nentry");
    // the second write finds the note and stays inside the section
    await vfm.editNote({ name: "Log#Today" }, "again", false, true);
    expect(fake.files.get("Flows/Log.md")).toBe("# Today\n\nentry\nagain\n");
    expect(written).toEqual(["Out", "Log#Today", "Log#Today"]);
    noForbidden(fake.calls);
  });

  test("not in the set, or a mock run, creates nothing", async () => {
    const { fake, vfm } = setup({ creatable: ["Other"] });
    expect(await vfm.editNote({ name: "Out" }, "x", false)).toBeNull();
    const mock = setup({ creatable: ["Out"], mock: true });
    expect(await mock.vfm.editNote({ name: "Out" }, "x", false)).toBeUndefined();
    expect(await mock.vfm.editNote({ name: "Out" }, "x", true)).toBeUndefined();
    expect([...fake.calls, ...mock.fake.calls]).toEqual([]);
  });

  test("parallel first writes to one missing note create it once, and both writes land", async () => {
    const { fake, vfm } = setup({ creatable: ["Out"] });
    const create = fake.app.vault.create.bind(fake.app.vault);
    // A real create resolves later: both writes see the note missing before it exists.
    fake.app.vault.create = async (path: string, data: string) => {
      await Promise.resolve();
      return create(path, data);
    };
    await Promise.all([vfm.editNote({ name: "Out" }, "a", false, true), vfm.editNote({ name: "Out" }, "b", false, true)]);
    expect(fake.calls.filter((c) => c.startsWith("create "))).toEqual(["create Flows/Out.md"]);
    expect(fake.files.get("Flows/Out.md")).toContain("b");
    expect(fake.files.get("Flows/Out.md")!.startsWith("a")).toBe(true);
  });

  test("a block subpath never creates", async () => {
    const { fake, vfm } = setup({ creatable: ["Out#^b"] });
    expect(await vfm.editNote({ name: "Out#^b" }, "x", false)).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  test("a name with folder segments is never created, even when outside creates were confirmed", async () => {
    for (const allowCreateOutsideFolder of [false, true]) {
      const { fake, vfm } = setup({ creatable: ["Sub/Deep", "../Up", "Sub/Deep#H"], flowFolder: "Flows", allowCreateOutsideFolder });
      expect(await vfm.editNote({ name: "Sub/Deep" }, "d", false)).toBeNull();
      expect(await vfm.editNote({ name: "Sub/Deep#H" }, "d", false)).toBeNull();
      expect(await vfm.editNote({ name: "../Up" }, "x", false)).toBeNull();
      expect(fake.calls).toEqual([]);
    }
    // an existing note with folders is still written
    const existing = setup({}, { "Flows/Sub/Deep.md": "old" });
    expect(await existing.vfm.editNote({ name: "Flows/Sub/Deep" }, "new", false)).toBeUndefined();
    expect(existing.fake.files.get("Flows/Sub/Deep.md")).toBe("new");
    const root = setup({ creatable: ["X"], flowFolder: "" });
    await root.vfm.editNote({ name: "X" }, "r", false);
    expect(root.fake.files.get("X.md")).toBe("r");
  });
});

describe("dotted note names (fix 1)", () => {
  const init = { "Flows/Meeting 2026.11.md": "# Meeting\nagenda\n", "Flows/v1.2.md": "## H\nold\n\n## K\nkeep\n" };
  test("existing dotted notes read and write as notes", async () => {
    const { fake, vfm } = setup({}, init);
    expect(await vfm.getNote({ name: "Meeting 2026.11" }, false)).toBe("# Meeting\nagenda\n");
    expect(await vfm.getNote({ name: "v1.2#H" }, false)).toBe("## H\nold");
    expect(await vfm.editNote({ name: "v1.2#H" }, "new", false)).toBeUndefined();
    expect(fake.files.get("Flows/v1.2.md")).toBe("## H\nnew\n\n## K\nkeep\n");
  });

  test("missing dotted names are missing notes, created on their first write", async () => {
    const names = ["Meeting 2026.11", "v1.2#H", "2026.11.04"];
    const { fake, vfm } = setup({ creatable: names });
    for (const n of names) {
      expect(vfm.isMissingNote(n)).toBe(true);
      expect(await vfm.getNote({ name: n }, false)).toBeNull();
    }
    for (const n of names) expect(await vfm.editNote({ name: n }, "w", false)).toBeUndefined();
    expect(fake.files.get("Flows/Meeting 2026.11.md")).toBe("w");
    expect(fake.files.get("Flows/v1.2.md")).toBe("# H\n\nw");
    expect(fake.files.get("Flows/2026.11.04.md")).toBe("w");
  });

  test("known attachment extensions stay link text, in any case", async () => {
    const { fake, vfm } = setup({ creatable: ["x.pdf", "img.PNG"] });
    expect(await vfm.getNote({ name: "x.pdf" }, false)).toBe("x.pdf");
    expect(await vfm.getNote({ name: "img.PNG" }, false)).toBe("img.PNG");
    expect(vfm.isMissingNote("x.pdf")).toBe(false);
    expect(vfm.isMissingNote("img.PNG")).toBe(false);
    expect(await vfm.editNote({ name: "img.PNG" }, "x", false)).toBeNull();
    expect(fake.calls).toEqual([]);
  });
});

describe("section writes and matching (fix 2, fix 4)", () => {
  test("headings in written text are demoted below the section, so a second write replaces it cleanly", async () => {
    const { fake, vfm } = setup({}, { [OUT]: OUT_BODY });
    await vfm.editNote({ name: "Out#Result" }, "## Analysis\ntext", false);
    expect(fake.files.get(OUT)).toBe("---\nk: v\n---\n# Out\nIntro.\n\n## Result\n### Analysis\ntext\n\n## Other\nkeep\n");
    await vfm.editNote({ name: "Out#Result" }, "## Analysis\nsecond", false);
    expect(fake.files.get(OUT)).toBe("---\nk: v\n---\n# Out\nIntro.\n\n## Result\n### Analysis\nsecond\n\n## Other\nkeep\n");
  });

  test("demotion leaves code fences and deeper headings alone, and escapes at level 6", () => {
    expect(writeSection("## R\nold\n", "R", "# Top\n```\n## code\n```\n#### deep", false)).toBe("## R\n### Top\n```\n## code\n```\n#### deep\n");
    expect(writeSection("###### R\nold\n", "R", "## a\n###### b\ntext", false)).toBe("###### R\n\\## a\n\\###### b\ntext\n");
  });

  test("headings indented by up to three spaces bound and name sections", () => {
    expect(writeSection("## Result\nold\n\n  ## Other\nkeep\n", "Result", "new", false)).toBe("## Result\nnew\n\n  ## Other\nkeep\n");
    expect(writeSection("   ## Result\nold\n## Other\nkeep\n", "Result", "new", false)).toBe("   ## Result\nnew\n\n## Other\nkeep\n");
    // four spaces is an indented code block, not a heading
    expect(writeSection("## Result\nold\n    ## code\n", "Result", "new", false)).toBe("## Result\nnew\n");
  });

  test("Setext headings bound, name and get demoted like ATX ones", () => {
    expect(writeSection("## Result\nold\n\nOther\n-----\nkeep\n", "Result", "new", false)).toBe("## Result\nnew\n\nOther\n-----\nkeep\n");
    expect(writeSection("Result\n======\nold\n\nNext\n====\nkeep\n", "Result", "new", false)).toBe("Result\n======\nnew\n\nNext\n====\nkeep\n");
    // a --- after a heading or a blank line is a thematic break, not a Setext underline
    expect(writeSection("## Result\nold\n\n---\nstill mine\n", "Result", "new", false)).toBe("## Result\nnew\n");
    // written Setext headings at or above the section's level go below it
    expect(writeSection("## R\nold\n", "R", "Top\n---\ntext", false)).toBe("## R\n### Top\ntext\n");
  });

  test("a fence indented four spaces is an indented code block, so it hides no headings", () => {
    expect(writeSection("## Result\nold\n\n    ```\n\n## Other\nkeep\n", "Result", "new", false)).toBe("## Result\nnew\n\n## Other\nkeep\n");
  });

  test("a longer fence holds a shorter fence and a heading line", async () => {
    const body = "## Result\nold\n````\n```\n## x\n```\n````\n## Other\nkeep\n";
    const { fake, vfm } = setup({}, { [OUT]: body });
    expect(await vfm.getNote({ name: "Out#Result" }, false)).toBe("## Result\nold\n````\n```\n## x\n```\n````");
    await vfm.editNote({ name: "Out#Result" }, "new", false);
    expect(fake.files.get(OUT)).toBe("## Result\nnew\n\n## Other\nkeep\n");
  });

  test("heading text is matched as link subpaths are: punctuation is a space, case and spacing ignored", async () => {
    const { fake, vfm } = setup({}, { [OUT]: "## Result: final\nold\n## Other\nkeep\n" });
    expect(await vfm.getNote({ name: "Out", subpath: "Result final" }, false)).toBe("## Result: final\nold");
    await vfm.editNote({ name: "Out#result  FINAL" }, "new", false);
    expect(fake.files.get(OUT)).toBe("## Result: final\nnew\n\n## Other\nkeep\n");
  });

  test("a nested subpath A#B matches the B under A", async () => {
    const body = "# A\n## B\nunder a\n# C\n## B\nunder c\n";
    const { fake, vfm } = setup({}, { [OUT]: body });
    expect(await vfm.getNote({ name: "Out", subpath: "C#B" }, false)).toBe("## B\nunder c");
    expect(await vfm.getNote({ name: "Out", subpath: "Missing#B" }, false)).toBe("## B\nunder a");
    await vfm.editNote({ name: "Out#C#B" }, "new", false);
    expect(fake.files.get(OUT)).toBe("# A\n## B\nunder a\n# C\n## B\nnew\n");
  });
});


describe("C5 continuation heading regressions", () => {
  test("appended container-looking text is demoted in its actual paragraph context", () => {
    const original = "## Result\nold\n\n## Other\nkeep\n";
    for (const text of ["2. item\n   # Summary\n   new", "<span>\n# Summary\n\nnew"]) {
      const appended = writeSection(original, "Result", text, true)!;
      expect(writeSection(appended, "Result", "replacement", false)).toBe("## Result\nreplacement\n\n## Other\nkeep\n");
    }
  });
  test("heading-scoped creation closes unfinished fences with terminal newlines before later prose", async () => {
    for (const fence of ["```js", "~~~text"]) for (const suffix of ["\n", "\n\n"]) {
      const { fake, vfm } = setup({ creatable: ["Out#Result"] });
      await vfm.editNote({ name: "Out#Result" }, `${fence}\ncode${suffix}`, false);
      await vfm.editNote({ name: "Out#Result" }, "next", false, true);
      expect(fake.files.get(OUT)).toContain(`${fence.slice(0, 3)}\nnext\n`);
      await vfm.editNote({ name: "Out#Result" }, "replacement", false);
      expect(fake.files.get(OUT)).toBe("# Result\nreplacement\n");
    }
  });
  test("container fences preserve siblings when read, replaced, appended and written again", () => {
    for (const block of ["- ```js\n  code\n  ```", "1. ```js\n   code\n   ```", "> ```js\n> code\n> ```", "- outer\n  - ```js\n    ## literal\n    ```", "    ```\n    code\n    ```"]) {
      const original = `## Result\nold\n\n${block}\n\n## Other\nkeep\n`;
      expect(writeSection(original, "Result", "new", false)).toBe("## Result\nnew\n\n## Other\nkeep\n");
      const added = writeSection("## Result\nold\n\n## Other\nkeep\n", "Result", block, true)!;
      expect(added).toEndWith("\n\n## Other\nkeep\n");
      expect(writeSection(added, "Result", "replacement", false)).toBe("## Result\nreplacement\n\n## Other\nkeep\n");
    }
  });
  test("output that hides a preserved sibling is refused without changing the note", async () => {
    const original = "## Result\nold\n\n## Other\nkeep\n";
    const { fake, vfm } = setup({}, { [OUT]: original });
    expect(await vfm.editNote({ name: "Out#Result" }, "<script>\nunfinished", false)).toBeNull();
    expect(fake.files.get(OUT)).toBe(original);
  });
  test("an appended underline cannot promote the existing paragraph outside its section", () => {
    const original = "## Result\nold\n\n## Other\nkeep\n";
    for (const underline of ["---", "===", "  ---", "   ==="]) {
      const appended = writeSection(original, "Result", `${underline}\nnew`, true)!;
      expect(appended).toBe(`## Result\nold\n\n${underline}\nnew\n\n## Other\nkeep\n`);
      expect(writeSection(appended, "Result", "replacement", false)).toBe("## Result\nreplacement\n\n## Other\nkeep\n");
    }
  });
  test("backticks in a backtick fence info string leave sibling headings outside code", () => {
    for (const indent of ["", " ", "  ", "   "]) {
      const body = `## Result\nold\n${indent}\`\`\`foo\`bar\n\n## Other\nkeep\n`;
      expect(writeSection(body, "Result", "new", false)).toBe("## Result\nnew\n\n## Other\nkeep\n");
    }
    // A tilde fence may have backticks in its info string.
    expect(writeSection("## Result\n~~~foo`bar\n## code\n~~~\n## Other\nkeep\n", "Result", "new", false)).toBe("## Result\nnew\n\n## Other\nkeep\n");
  });
  test("an empty ATX sibling bounds a write; empty output headings are demoted", () => {
    expect(writeSection("## Result\nold\n\n##\nkeep\n", "Result", "new", false)).toBe("## Result\nnew\n\n##\nkeep\n");
    expect(writeSection("## Result\nold\n", "Result", "##\ntext", false)).toBe("## Result\n###\ntext\n");
  });
  test("a heading-scoped first write demotes its content, so replacement removes it", async () => {
    const { fake, vfm } = setup({ creatable: ["Out#Result"] });
    await vfm.editNote({ name: "Out#Result" }, "# Summary\nfirst", false);
    expect(fake.files.get("Flows/Out.md")).toBe("# Result\n\n## Summary\nfirst");
    await vfm.editNote({ name: "Out#Result" }, "second", false);
    expect(fake.files.get("Flows/Out.md")).toBe("# Result\nsecond\n");
  });
});


describe("continuation review regressions", () => {
  for (const append of [false, true]) {
    for (const fence of ["```js", "~~~~text", "````\n```\n## literal"]) {
      test(`unterminated ${fence} stays inside its section (append=${append})`, async () => {
        const { fake, vfm } = setup({}, { [OUT]: OUT_BODY });
        const payload = `${fence}\nunfinished output`;
        await vfm.editNote({ name: "Out#Result" }, payload, false, append);
        expect(fake.files.get(OUT)).toContain(payload);
        expect(await vfm.getNote({ name: "Out#Other" }, false)).toBe("## Other\nkeep");
        await vfm.editNote({ name: "Out#Result" }, "replacement", false);
        expect(fake.files.get(OUT)).toBe(OUT_BODY.slice(0, OUT_BODY.indexOf("old")) + "replacement\n\n## Other\nkeep\n");
        noForbidden(fake.calls);
      });
    }
  }

  test("Out and Out.md serialize delayed creation even before metadata indexes it", async () => {
    const { fake, vfm } = setup({ creatable: ["Out", "Out.md"] });
    const create = fake.app.vault.create;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fake.app.vault.create = async (path, data) => { await gate; return create(path, data); };
    // Real Obsidian indexes metadata asynchronously; direct vault lookup sees the created file.
    fake.app.metadataCache.getFirstLinkpathDest = () => null;
    const first = vfm.editNote({ name: "Out" }, "first", false);
    const second = vfm.editNote({ name: "Out.md" }, "second", false, true);
    release();
    expect(await Promise.allSettled([first, second])).toEqual([
      { status: "fulfilled", value: undefined }, { status: "fulfilled", value: undefined },
    ]);
    expect(fake.files.get(OUT)).toBe("firstsecond");
    expect(fake.calls.filter((c) => c.startsWith("create "))).toEqual([`create ${OUT}`]);
    expect(fake.calls).toContain(`process ${OUT}`);
  });

  test("a nested first-create target can be read, replaced and appended again", async () => {
    const { fake, vfm } = setup({ creatable: ["Out#A#B"] });
    expect(await vfm.editNote({ name: "Out#A#B" }, "## Output\nfirst", false)).toBeUndefined();
    expect(fake.files.get(OUT)).toBe("# A\n\n## B\n\n### Output\nfirst");
    expect(await vfm.getNote({ name: "Out#A#B" }, false)).toBe("## B\n\n### Output\nfirst");
    await vfm.editNote({ name: "Out#A#B" }, "second", false);
    await vfm.editNote({ name: "Out#A#B" }, "third", false, true);
    expect(fake.files.get(OUT)).toBe("# A\n\n## B\nsecond\nthird\n");
  });

  test("unrepresentable nested creation refuses before mutation", async () => {
    const name = "Out#A#B#C#D#E#F#G";
    const { fake, vfm } = setup({ creatable: [name] });
    expect(await vfm.editNote({ name }, "output", false)).toBeNull();
    expect(fake.files.has(OUT)).toBe(false);
    expect(fake.calls).toEqual([]);
  });
});
