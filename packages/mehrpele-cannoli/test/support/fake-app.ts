// An in-memory Obsidian app for the companion's logic modules (structurally typed, no obsidian
// import). Vault files and adapter paths share one namespace, as on disk. Every IO call is logged;
// delete/trash/rename/modify throw, so a test fails loudly if a module ever reaches them.

export interface FakeFile {
  path: string;
  basename: string;
  extension: string;
}

export const fileOf = (path: string): FakeFile => {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return { path, basename: dot > 0 ? name.slice(0, dot) : name, extension: dot > 0 ? name.slice(dot + 1) : "" };
};

const parentOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export function fakeApp(init: Record<string, string> = {}) {
  const files = new Map(Object.entries(init));
  const folders = new Set<string>();
  const calls: string[] = [];
  const secrets = new Map<string, string>();
  const secretCalls: string[] = [];
  const frontmatter = new Map<string, Record<string, unknown>>();

  const ensureParents = (p: string): void => {
    for (let d = parentOf(p); d; d = parentOf(d)) folders.add(d);
  };
  for (const p of files.keys()) ensureParents(p);
  const forbidden =
    (name: string) =>
    (..._args: unknown[]): never => {
      calls.push(name);
      throw new Error(`${name} must not be called`);
    };

  const vault = {
    configDir: ".obsidian",
    async cachedRead(f: FakeFile): Promise<string> {
      calls.push(`cachedRead ${f.path}`);
      const v = files.get(f.path);
      if (v === undefined) throw new Error(`No file ${f.path}`);
      return v;
    },
    async readBinary(f: FakeFile): Promise<ArrayBuffer> {
      calls.push(`readBinary ${f.path}`);
      return new TextEncoder().encode(files.get(f.path) ?? "").buffer as ArrayBuffer;
    },
    async process(f: FakeFile, fn: (data: string) => string): Promise<string> {
      calls.push(`process ${f.path}`);
      const next = fn(files.get(f.path) ?? "");
      files.set(f.path, next);
      return next;
    },
    async create(path: string, data: string): Promise<FakeFile> {
      calls.push(`create ${path}`);
      if (files.has(path)) throw new Error("File already exists.");
      files.set(path, data);
      ensureParents(path);
      return fileOf(path);
    },
    async createFolder(path: string): Promise<void> {
      calls.push(`createFolder ${path}`);
      folders.add(path);
      ensureParents(path);
    },
    getAbstractFileByPath(p: string): unknown {
      if (files.has(p)) return fileOf(p);
      if (folders.has(p)) return { path: p, children: [] };
      return null;
    },
    modify: forbidden("modify"),
    delete: forbidden("delete"),
    trash: forbidden("trash"),
    rename: forbidden("rename"),
    adapter: {
      async exists(p: string): Promise<boolean> {
        return files.has(p) || folders.has(p);
      },
      async read(p: string): Promise<string> {
        calls.push(`adapter.read ${p}`);
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
      },
      async write(p: string, d: string): Promise<void> {
        calls.push(`adapter.write ${p}`);
        files.set(p, d);
        ensureParents(p);
      },
      async mkdir(p: string): Promise<void> {
        folders.add(p);
        ensureParents(p);
      },
      async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
        return {
          files: [...files.keys()].filter((f) => parentOf(f) === dir),
          folders: [...folders].filter((f) => parentOf(f) === dir),
        };
      },
      async remove(p: string): Promise<void> {
        calls.push(`adapter.remove ${p}`);
        files.delete(p);
      },
      async rmdir(p: string): Promise<void> {
        calls.push(`adapter.rmdir ${p}`);
        folders.delete(p);
      },
    },
  };

  const metadataCache = {
    getFirstLinkpathDest(linkpath: string, source: string): FakeFile | null {
      // Obsidian prefers an existing same-folder target for an unqualified link.
      if (!linkpath.includes("/")) {
        const folder = parentOf(source);
        const relative = folder ? `${folder}/${linkpath}` : linkpath;
        if (files.has(relative)) return fileOf(relative);
        if (files.has(relative + ".md")) return fileOf(relative + ".md");
      }
      // A link with a non-markdown extension matches that file by path or by name; else, as
      // Obsidian does, it may still name a note ("Meeting 2026.11" -> "Meeting 2026.11.md").
      if (/\.[A-Za-z0-9]+$/.test(linkpath) && !linkpath.endsWith(".md")) {
        for (const p of files.keys()) if (p === linkpath || p.endsWith(`/${linkpath}`)) return fileOf(p);
      }
      const want = linkpath.replace(/\.md$/, "");
      for (const p of files.keys()) {
        if (!p.endsWith(".md")) continue;
        if (p.slice(0, -3) === want || fileOf(p).basename === want) return fileOf(p);
      }
      return null;
    },
    // Front matter set on a note is visible in its cache, as Obsidian's index would show it.
    getFileCache: (f: FakeFile): unknown => (frontmatter.has(f.path) ? { frontmatter: { ...frontmatter.get(f.path) } } : null),
  };

  const fileManager = {
    async processFrontMatter(f: FakeFile, fn: (fm: Record<string, unknown>) => void): Promise<void> {
      calls.push(`processFrontMatter ${f.path}`);
      const fm = frontmatter.get(f.path) ?? {};
      fn(fm);
      frontmatter.set(f.path, fm);
    },
  };

  const secretStorage = {
    getSecret(id: string): string | null {
      secretCalls.push(`get ${id}`);
      return secrets.get(id) ?? null;
    },
    setSecret(id: string, value: string): void {
      secretCalls.push(`set ${id}`);
      secrets.set(id, value);
    },
    listSecrets(): string[] {
      secretCalls.push("list");
      return [...secrets.keys()];
    },
  };

  const app = {
    vault,
    metadataCache,
    fileManager,
    secretStorage,
    plugins: { plugins: {} as Record<string, unknown> },
    workspace: { activeEditor: null as { editor?: { replaceSelection(t: string): void } } | null },
  };
  return { app, files, folders, calls, secrets, secretCalls, frontmatter };
}

export type FakeApp = ReturnType<typeof fakeApp>;

/** A plugin's loadData/saveData, kept in memory as JSON (what data.json would hold). */
export function fakeSettingsHost(initial: unknown = null) {
  const host = {
    json: initial === null ? null : JSON.stringify(initial),
    saves: 0,
    async loadData(): Promise<unknown> {
      return host.json === null ? null : JSON.parse(host.json);
    },
    async saveData(data: unknown): Promise<void> {
      host.saves++;
      host.json = JSON.stringify(data);
    },
  };
  return host;
}
