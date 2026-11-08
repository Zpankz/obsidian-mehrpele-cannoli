                                                                                           
// 2.3.3's VaultInterface, with these differences:
//   - reads use vault.cachedRead, front matter reads metadataCache.getFileCache; note writes use
//     vault.process (frontmatter is kept unless the reference includes properties); front matter
//     edits use fileManager.processFrontMatter;
//   - it never deletes, moves or renames anything: moveNote throws;
//   - creating a note or folder outside the flow's folder needs the run's confirmation to have
//     listed it (`allowCreateOutsideFolder`);
//   - every created or edited path passes safeVaultPath: no "..", ".", leading "/", drive
//     prefix or backslash, and nothing inside the vault's config folder;
                                                                           
//   - a reference may be a link name or a vault path ending in ".md".
// No runtime obsidian import: the app is structurally typed and resolveSubpath is injected.
import { isAttachment } from "./attachments";
import MarkdownIt from "markdown-it";
import { load as loadYaml, dump as dumpYaml } from "js-yaml";

export interface TFileLike {
  path: string;
  basename: string;
  extension: string;
}

export interface SubpathResultLike {
  start: { line: number };
  end: { line: number } | null;
}

export interface VaultApp {
  vault: {
    cachedRead(file: TFileLike): Promise<string>;
    readBinary(file: TFileLike): Promise<ArrayBuffer>;
    process(file: TFileLike, fn: (data: string) => string): Promise<string>;
    create(path: string, data: string): Promise<unknown>;
    createFolder(path: string): Promise<unknown>;
    getAbstractFileByPath(path: string): unknown;
    /** The vault's config folder (".obsidian" by default); never written by a flow. */
    configDir?: string;
  };
  metadataCache: {
    getFirstLinkpathDest(linkpath: string, sourcePath: string): TFileLike | null;
    getFileCache?(file: TFileLike): unknown;
  };
  fileManager: {
    processFrontMatter(file: TFileLike, fn: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  };
  workspace?: { activeEditor?: { editor?: { replaceSelection(text: string): void } | null } | null };
}

export interface ReferenceLike {
  name: string;
  type?: string;
  shouldExtract?: boolean;
  includeName?: boolean;
  includeProperties?: boolean;
  includeLink?: boolean;
  subpath?: string;
}

export interface VaultFileManagerOptions {
  /** Immutable explicit child workflows captured during preflight; unknown children fail closed. */
  workflowCanvases?: ReadonlyMap<string, string>;
  workflowSnapshots?: ReadonlyMap<string, string>;
  workflowBindings?: ReadonlyMap<string, string>;
  workflowMetadata?: ReadonlyMap<string, unknown>;
  workflowProperties?: ReadonlyMap<string, Record<string, unknown>>;
  workflowBinaries?: ReadonlyMap<string, ArrayBuffer>;
  workflowMaxBytes?: number;
  workflowText?: (text: string) => string;
  /** Vault path of the flow's folder ("" for the vault root). */
  flowFolder: string;
  /** True when the confirmed reference set listed notes created outside flowFolder. */
  allowCreateOutsideFolder: boolean;
  /** Mock runs: getNote returns a fixed body without IO, and nothing is written. */
  mock?: boolean;
  /** Obsidian's resolveSubpath, injected so this module stays obsidian-free at runtime. */
  resolveSubpath?(cache: unknown, subpath: string): SubpathResultLike | null;
                                                                 
  sourcePath?: string;
                                                                                                
  creatable?: string[];
                                                                                            
  onWrite?(name: string): void;
}

/** A reference target: the note name (no alias, no subpath) and its subpath (no leading "#"). */
interface Target {
  name: string;
  subpath: string;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// CommonMark: up to three spaces of indent (four is a code block).
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)\s*$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const markdown = new MarkdownIt("commonmark");

// Tables are structured Obsidian blocks too; other Markdown processing stays CommonMark.
const blockMarkdown = new MarkdownIt("commonmark").enable("table");
function blockRange(content: string, id: string): { start: number; end: number } | null {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  const source = content.replace(FRONTMATTER, block => block.replace(/[^\n]/g, ""));
  const lines = source.split("\n");
  const tokens = blockMarkdown.parse(source, {}), open: typeof tokens = [];
  let previous: (typeof tokens)[number] | undefined;
  let found: { start: number; end: number } | null = null;
  const ending = new RegExp(`(?:^|\\s)\\^${id}\\s*$`);
  for (const token of tokens) {
    if (token.nesting === 1) { open.push(token); continue; }
    if (token.nesting === -1) {
      const closed = open.pop();
      if (closed?.level === 0 && closed.map) previous = closed;
      continue;
    }
    if (token.type === "inline" && token.map && ending.test(token.content) && token.children?.at(-1)?.type === "text") {
      let range: [number, number] | undefined;
      if (token.level === 1 && token.content.trim() === `^${id}`) {
        if (previous?.map && lines.slice(previous.map[1], token.map[0]).every(line => !line.trim())) range = previous.map;
      } else if (!open.some(parent => parent.type === "blockquote_open" || parent.type === "table_open")) {
        const owner = open.filter(parent => parent.type === "list_item_open").at(-1)
          ?? open.filter(parent => parent.type === "paragraph_open" || parent.type === "heading_open").at(-1);
        range = owner?.map ?? undefined;
      }
      if (range) {
        if (found) return null; // IDs must be unique; do not guess between duplicate blocks.
        found = { start: range[0], end: range[1] };
      }
    }
    if (token.level === 0 && token.map && token.type !== "inline") previous = token;
  }
  return found;
}

/** "Name#Heading" splits when the reference has no subpath of its own. */
function targetOf(reference: ReferenceLike): Target {
  let name = linkpathOf(reference.name);
  let subpath = reference.subpath ?? "";
  if (!subpath && name.includes("#")) {
    subpath = name.slice(name.indexOf("#") + 1);
    name = name.slice(0, name.indexOf("#"));
  }
  return { name: name.trim(), subpath: subpath.replace(/^#/, "").trim() };
}

const linkText = (t: Target): string => (t.subpath ? `${t.name}#${t.subpath}` : t.name);

/** True when a written name has folder segments: such a note is never created on write (fix 3). */
export function hasFolder(name: string): boolean {
  return targetOf({ name }).name.includes("/");
}

/** Heading text as Obsidian link subpaths compare it: `# | ^ : % [ ] \` are spaces, case and spacing ignored. */
const headingKey = (text: string): string =>
  text
    .replace(/[#|^:%[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

interface HeadingLine {
  /** First line of the heading. */
  i: number;
  /** First line after it (a Setext heading spans its paragraph and underline). */
  body: number;
  level: number;
  key: string;
}

/** Section headings, with container/fence/HTML boundaries supplied by CommonMark. */
function headingLines(lines: string[]): HeadingLine[] {
  const tokens = markdown.parse(lines.join("\n"), {});
  const headings: HeadingLine[] = [];
  tokens.forEach((token, index) => {
    // List/quote headings belong to their containers, not the surrounding section outline.
    if (token.type !== "heading_open" || token.level !== 0 || !token.map) return;
    headings.push({ i: token.map[0], body: token.map[1], level: Number(token.tag.slice(1)), key: headingKey(tokens[index + 1]?.content ?? "") });
  });
  return headings;
}

interface Section {
  start: number;
  body: number;
  end: number;
  level: number;
}

/**
 * The section a heading subpath names (heading start, body start, end), skipping code fences; null if absent.
 * A nested "A#B" picks the B inside A's section, else the first B anywhere.
 */
function headingRange(lines: string[], subpath: string): Section | null {
  if (subpath.startsWith("^")) return null;
  const headings = headingLines(lines);
  const endOf = (h: HeadingLine): number => headings.find((o) => o.i > h.i && o.level <= h.level)?.i ?? lines.length;
  const segments = subpath.split("#").map(headingKey).filter(Boolean);
  if (!segments.length) return null;
  let [from, to] = [0, lines.length];
  let hit: HeadingLine | null = null;
  for (const segment of segments) {
    hit = headings.find((h) => h.i >= from && h.i < to && h.key === segment) ?? null;
    if (!hit) break;
    [from, to] = [hit.body, endOf(hit)];
  }
  hit ??= headings.find((h) => h.key === segments[segments.length - 1]) ?? null;
  return hit ? { start: hit.i, body: hit.body, end: endOf(hit), level: hit.level } : null;
}

/**
 * Written text whose headings would end a level-`level` section, demoted below it (fix 2):
 * a heading of that level or higher becomes level+1, or at level 6 is escaped ("\\## x").
 */
function demoteHeadings(text: string, level: number): string {
  const lines = text.split("\n");
  const out: (string | null)[] = [...lines];
  for (const h of headingLines(lines)) {
    if (h.level > level) continue;
    if (h.body === h.i + 1) {
      const line = lines[h.i];
      const hashes = line.match(HEADING)?.[1].length ?? 0;
      out[h.i] = level >= 6 ? `\\${line}` : "#".repeat(level + 1) + line.slice(line.indexOf("#") + hashes);
    } else if (level >= 6) {
      out[h.body - 1] = `\\${lines[h.body - 1].trim()}`;
    } else {
      // A Setext heading becomes an ATX one a level below the section.
      out[h.i] = `${"#".repeat(level + 1)} ${lines.slice(h.i, h.body - 1).map((l) => l.trim()).join(" ")}`;
      for (let j = h.i + 1; j < h.body; j++) out[j] = null;
    }
  }
  const result = out.filter((l): l is string => l !== null);
  // A truncated response must not turn preserved siblings (or later appends) into code.
  const tail = markdown.parse(result.join("\n"), {}).filter((t) => t.type === "fence" && t.level === 0).at(-1);
  // Parser maps exclude the phantom line after a terminal newline.
  const end = result.length - (result.at(-1) === "" ? 1 : 0);
  if (tail?.map && tail.map[1] === end) {
    const close = result[end - 1]?.match(FENCE_CLOSE)?.[1];
    if (tail.map[1] === tail.map[0] + 1 || !close || close[0] !== tail.markup[0] || close.length < tail.markup.length) result.splice(end, 0, tail.markup);
  }
  return result.join("\n");
}

/** `data` with one heading section's body replaced or appended to; null if the heading is missing. */
export function writeSection(data: string, heading: string, text: string, append: boolean): string | null {
  const fm = data.match(FRONTMATTER)?.[0] ?? "";
  const lines = data.slice(fm.length).split("\n");
  const range = headingRange(lines, heading);
  if (!range) return null;
  const { body: from, end, level } = range;
  const old = lines.slice(from, end).join("\n").replace(/\s+$/, "");
  const add = demoteHeadings(text.replace(/^\n+/, "").replace(/\s+$/, ""), level);
  // An underline at the join must not turn the preceding paragraph into a sibling heading.
  const separator = SETEXT_UNDERLINE.test(add.split("\n", 1)[0]) ? "\n\n" : "\n";
  const body = append && old ? demoteHeadings(`${old}${separator}${add}`, level) : add;
  const after = end < lines.length ? ["", ...lines.slice(end)] : [""];
  const written = [...lines.slice(0, from), ...(body ? body.split("\n") : []), ...after];
  // Refuse output that would swallow a preserved sibling (for example an unclosed HTML block).
  if (end < lines.length) {
    const boundary = written.length - (lines.length - end);
    if (!headingLines(written).some((h) => h.i === boundary)) return null;
  }
  return fm + written.join("\n");
}

export const MOCK_NOTE_BODY = "Mock note body.";
const FRONTMATTER = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/;
function readFrontmatter(content: string): Record<string, unknown> {
  const block = content.match(FRONTMATTER)?.[0];
  if (!block) return {};
  try {
    const value = loadYaml(block.slice(block.indexOf("\n") + 1, block.lastIndexOf("---")));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; } // Invalid frontmatter has no readable properties, as in the metadata cache.
}
function withFrontmatter(content: string, properties: Record<string, unknown>): string {
  return `---\n${dumpYaml(properties, { lineWidth: -1, quotingType: '"', forceQuotes: true })}---\n${content.replace(FRONTMATTER, "")}`;
}
const IMAGE_EXT = /\.(jpe?g|png|gif|bmp|tiff|webp|svg|ico|jfif|avif)$/i;
const MAX_EMBED_DEPTH = 10;

/** "[[Note|alias]]" -> "Note". */
export function linkpathOf(name: string): string {
  let path = name;
  if (path.includes("|")) path = path.split("|")[0];
  return path.replace("[[", "").replace("]]", "").trim();
}

const joinPath = (...parts: (string | undefined)[]): string => parts.filter((p): p is string => !!p).join("/");

/**
 * Normalises a vault-relative path a flow asked to write, or throws. Refused: backslashes, a
 * leading "/" or drive prefix ("C:"), any "." or ".." segment (or one made only of dots and
 * spaces, which Windows trims to one), and anything inside the vault's config folder.
 */
export function safeVaultPath(raw: string, configDir = ".obsidian"): string {
  const refuse = (why: string): never => {
    throw new Error(`Mehrpele Flows refused to write "${raw}": ${why}`);
  };
  if (raw.includes("\\")) refuse("backslashes are not allowed in vault paths");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) refuse("the path must be relative to the vault");
  const segments = raw.split("/").filter((s) => s !== "");
  if (segments.some((s) => /^[.\s]+$/.test(s))) refuse('"." and ".." are not allowed in vault paths');
  const path = segments.join("/");
  const config = configDir.replace(/^\/+|\/+$/g, "").toLowerCase();
  const lower = path.toLowerCase();
  if (config && (lower === config || lower.startsWith(config + "/"))) refuse("the vault's config folder is off limits");
  return path;
}

const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Minimal YAML for front matter values (scalars, lists and nested maps). */
export function toYaml(value: unknown, indent = ""): string {
  if (Array.isArray(value)) return value.map((v) => `${indent}- ${scalar(v)}`).join("\n");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) =>
        v && typeof v === "object" ? `${indent}${k}:\n${toYaml(v, indent + "  ")}` : `${indent}${k}: ${scalar(v)}`,
      )
      .join("\n");
  }
  return `${indent}${scalar(value)}`;
}
// Primitive front matter values deliberately use JavaScript string coercion.
const scalar = (v: unknown): string =>
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Preserve primitive front matter coercion.
  v === null || v === undefined ? "null" : typeof v === "string" && /[:#\n]|^\s|\s$/.test(v) ? JSON.stringify(v) : String(v);

export class VaultFileManager {
  /** First-write creates in flight, by validated canonical vault path. */
  private creating = new Map<string, Promise<boolean>>();
  /** Complete run-owned property views; whole-note metadata writes replace them. */
  private propertyWrites = new Map<string, Map<string, unknown>>();
  private bodyWrites = new Map<string, string>();

  constructor(
    private app: VaultApp,
    private opts: VaultFileManagerOptions,
  ) {}

  forSource(sourcePath: string): VaultFileManager {
    const slash = sourcePath.lastIndexOf("/");
    const scoped = new VaultFileManager(this.app, { ...this.opts, sourcePath, flowFolder: slash < 0 ? "" : sourcePath.slice(0, slash) });
    scoped.creating = this.creating;
    scoped.propertyWrites = this.propertyWrites;
    scoped.bodyWrites = this.bodyWrites;
    return scoped;
  }

  /** Resolves a link name or a vault path (with ".md") to a file. */
  resolve(name: string): TFileLike | null {
    const linkpath = linkpathOf(name);
    const source = this.opts.sourcePath ?? "";
    if (this.opts.workflowBindings) {
      const pinned = this.opts.workflowBindings.get(`${source}\0${linkpath}`);
      if (pinned) {
        const file = this.app.vault.getAbstractFileByPath(pinned) as TFileLike | null;
        return file?.extension ? file : null;
      }
    }
    // A successful creation grants this run access to its own canonical body,
    // including the extensionless paths produced by the engine. No new vault read.
    const folder = (this.opts.sourcePath ?? "").split("/").slice(0,-1).join("/");
    const relative = !linkpath.includes("/") && folder ? `${folder}/${linkpath}` : linkpath;
    for (const path of [relative, relative + ".md", linkpath, linkpath + ".md"]) {
      if (!this.bodyWrites.has(path)) continue;
      const file = this.app.vault.getAbstractFileByPath(path) as TFileLike | null;
      if (file?.extension) return file;
    }
    const captured = (this.opts.workflowSnapshots?.has(linkpath) || this.opts.workflowBinaries?.has(linkpath)) ? this.app.vault.getAbstractFileByPath(linkpath) as TFileLike | null : null;
    if (captured?.extension) return captured;
    if (this.opts.workflowBindings) return null;
    const hit = this.app.metadataCache.getFirstLinkpathDest(linkpath, source);
    if (hit) return hit;
    if (linkpath.endsWith(".md")) {
      const byPath = this.app.vault.getAbstractFileByPath(linkpath) as TFileLike | null;
      if (byPath && typeof byPath === "object" && "extension" in byPath) return byPath;
      return this.app.metadataCache.getFirstLinkpathDest(linkpath.slice(0, -3), source);
    }
    return null;
  }

     
                                                                                            
                                                                                      
     
  private note(t: Target): TFileLike | "link" | null {
    if (SCHEME.test(t.name)) return "link";
    const file = this.resolve(t.name);
    if (file) return file.extension.toLowerCase() === "md" ? file : "link";
    return isAttachment(t.name) ? "link" : null;
  }

  /** True when a written name is a markdown note that does not exist yet (no IO). */
  isMissingNote(name: string): boolean {
    return this.note(targetOf({ name })) === null;
  }

  /** The confirmed creation path, shared by .md and extensionless references. */
  private creationPath(t: Target): string | null {
    const allowed = new Set((this.opts.creatable ?? []).map((n) => targetOf({ name: n }).name));
    // A name with folders must already exist: creating would need folders the run never confirmed.
    if (!allowed.has(t.name) || t.name.includes("/")) return null;
    return this.creatable(joinPath(this.opts.flowFolder, `${t.name.replace(/\.md$/i, "")}.md`));
  }

  /** A nested subpath creates a real hierarchy, with output scoped below its leaf. */
  private creationBody(t: Target, newContent: string): string | null {
    if (!t.subpath) return newContent;
    const segments = t.subpath.split("#").map((s) => s.trim());
    // Markdown has six heading levels. Reject unaddressable targets before mutating the vault.
    if (segments.length > 6 || segments.some((s) => !headingKey(s) || /[\r\n]/.test(s))) return null;
    return segments.map((s, i) => `${"#".repeat(i + 1)} ${s}`).join("\n\n")
      + `\n\n${demoteHeadings(newContent, segments.length)}`;
  }

  /**
   * The normalised path of a note (or folder) to create, or throws: it must pass safeVaultPath,
   * and its folder must be the flow's folder unless the confirmation listed creates outside it.
   */
  private creatable(raw: string, isFolder = false): string {
    const path = safeVaultPath(raw, this.app.vault.configDir);
    const folder = isFolder ? path : parentOf(path);
    const flow = this.opts.flowFolder;
    const inside = flow === "" ? folder === "" : folder === flow || folder.startsWith(flow + "/");
    if (!inside && !this.opts.allowCreateOutsideFolder) {
      throw new Error(`Creating notes in "${folder || "/"}" was not part of this flow's confirmation`);
    }
    return path;
  }

  /** An existing note a flow asked to edit, or null; its path must pass safeVaultPath. */
  private editable(name: string): TFileLike | null {
    const file = this.resolve(name);
    if (file) safeVaultPath(file.path, this.app.vault.configDir);
    return file;
  }

  async editNote(reference: ReferenceLike, newContent: string, isMock: boolean, append?: boolean): Promise<void | null> {
    if (isMock || this.opts.mock) return;
    const ownContent = newContent;
    newContent = this.opts.workflowText?.(newContent) ?? newContent;
    const t = targetOf(reference);
    const pinned = this.opts.workflowBindings?.get(`${this.opts.sourcePath ?? ""}\0${t.name}`);
    if (pinned && this.opts.workflowSnapshots?.has(pinned) && !this.app.vault.getAbstractFileByPath(pinned)) throw Error(`Prepared write target no longer exists: ${pinned}`);
                                                                              
    if (t.subpath.startsWith("^")) return null;
    let file = this.note(t);
    if (file === "link") return null;
    if (!file) {
      const path = this.creationPath(t);
      const body = this.creationBody(t, newContent);
      if (path === null || body === null) return null;
      const key = path.toLowerCase();
      const pending = this.creating.get(key);
      if (pending) await pending;
      // Vault registration precedes metadata indexing. Do not retry creation on a stale cache.
      const created = this.app.vault.getAbstractFileByPath(path) as TFileLike | null;
      if (created && created.extension?.toLowerCase() === "md") file = created;
      else {
        const create = this.app.vault.create(path, body).then(() => true).finally(() => this.creating.delete(key));
        this.creating.set(key, create);
        await create;
        if (this.opts.workflowSnapshots) this.bodyWrites.set(path, this.creationBody(t, ownContent)!);
        this.opts.onWrite?.(reference.name);
        return;
      }
    }
    safeVaultPath(file.path, this.app.vault.configDir);
    const update = (content: string, value: string): string | null => {
      if (t.subpath) return writeSection(content, t.subpath, value, !!append);
      if (append) return content + value;
      if (reference.includeProperties) return value;
      const fm = content.match(FRONTMATTER)?.[0];
      return fm ? fm + value : value;
    };
    let found = true;
    await this.app.vault.process(file, content => {
      const next = update(content, newContent);
      found = next !== null;
      return next ?? content;
    });
    if (!found) return null;
    if (this.opts.workflowSnapshots) {
      // Apply only our edit to the frozen/owned view. Taking process's entire
      // return value would also admit unrelated external changes to this note.
      const prior = this.bodyWrites.get(file.path) ?? this.opts.workflowSnapshots.get(file.path) ?? "";
      const next = update(prior, ownContent);
      if (next !== null) {
        this.bodyWrites.set(file.path, next);
        if (reference.includeProperties && !t.subpath && !append) this.propertyWrites.set(file.path, new Map(Object.entries(readFrontmatter(next))));
      }
    }
    this.opts.onWrite?.(reference.name);
  }

  async getNote(reference: ReferenceLike, isMock: boolean, recursionCount = 0): Promise<string | null> {
    if (isMock || this.opts.mock) return `# ${reference.name}\n${MOCK_NOTE_BODY}`;
    const t = targetOf(reference);
    const file = this.note(t);
    if (file === "link") return linkText(t);
    if (!file) return null;
    let content: string;
    if (this.opts.workflowSnapshots) {
      const snapshot = this.bodyWrites.get(file.path) ?? this.opts.workflowSnapshots.get(file.path);
      if (snapshot === undefined) throw Error(`Note was not prepared for this workflow: ${file.path}`);
      content = snapshot;
    } else content = await this.app.vault.cachedRead(file);

    if (t.subpath) {
      const section = this.section(file, content, t.subpath);
      if (section === null) return null;
      content = section;
      if (reference.includeLink) content = `[[${file.path}#${t.subpath}|${file.basename}]]\n\n${content}`;
      content = content.trim();
      if (!content) return null;
    } else {
      if (!reference.includeProperties) content = content.replace(FRONTMATTER, "");
      if (reference.includeLink) content = `[[${file.path}|${file.basename}]]\n\n${content}`;
      if (reference.includeName) content = `# ${file.basename}\n${content}`;
    }

    for (const embed of content.match(/!\[\[[\s\S]*?\]\]/g) ?? []) {
      let name = embed.slice(3, -2);
      if (IMAGE_EXT.test(name.split("|")[0])) {
        const parts = name.split("|");
        const image = this.forSource(file.path).resolve(parts[0]);
        const pinned = this.opts.workflowBindings?.get(`${file.path}\0${parts[0]}`);
        const path = image?.path ?? pinned;
        if (path && this.opts.workflowBinaries?.has(path)) content = content.replace(embed, `![[${path}${parts.length > 1 ? "|" + parts.slice(1).join("|") : ""}]]`);
        continue;
      }
      if (name.includes("|")) name = name.split("|")[0];
      let subpath: string | undefined;
      if (name.includes("#")) { const hash = name.indexOf("#"); subpath = name.slice(hash + 1); name = name.slice(0, hash); }
      if (name === reference.name || recursionCount >= MAX_EMBED_DEPTH) continue;
                                                                      
      const scoped = this.forSource(file.path);
      const embeddedFile = scoped.resolve(name || file.path);
      if (!embeddedFile || embeddedFile.extension.toLowerCase() !== "md") continue;
      const inner = await scoped.getNote({ name: embeddedFile.path, type: "note", shouldExtract: true, includeName: true, subpath }, false, recursionCount + 1);
      if (inner) {
        const inserted = "> " + inner.replace(/\n/g, "\n> ");
        if (this.opts.workflowMaxBytes && new TextEncoder().encode(content).byteLength + new TextEncoder().encode(inserted).byteLength > this.opts.workflowMaxBytes) throw Error("Expanded note byte limit exceeded");
        content = content.replace(embed, inserted);
      }
    }
    return content;
  }

  /** Heading or block section of a note, via Obsidian's resolveSubpath when available. */
  private section(file: TFileLike, content: string, subpath: string): string | null {
    const lines = content.split("\n");
    const owned = this.bodyWrites.has(file.path);
    const frozen = this.opts.workflowSnapshots?.get(file.path);
    const sameBody = frozen !== undefined && content.replace(FRONTMATTER, "") === frozen.replace(FRONTMATTER, "");
    const cache = owned && !sameBody ? null : this.opts.workflowMetadata ? this.opts.workflowMetadata.get(file.path) : this.app.metadataCache.getFileCache?.(file);
    const hit = cache && this.opts.resolveSubpath ? this.opts.resolveSubpath(cache, `#${subpath.replace(/^#/, "")}`) : null;
    if (hit) {
      // Property writes can move unchanged blocks by changing frontmatter height.
      const headerLines = (text: string) => (text.match(FRONTMATTER)?.[0].match(/\n/g) ?? []).length;
      const shift = owned && frozen !== undefined ? headerLines(content) - headerLines(frozen) : 0;
      const start = hit.start.line + shift;
      const end = hit.end ? hit.end.line + shift : null;
      if (end !== null && end === start) return lines[start].trim();
      return lines.slice(start, end ?? undefined).join("\n");
    }
    // Owned text has no native cache yet. Resolve its blocks from Markdown
    // structure, never from stale live-vault positions or matching arbitrary text.
    const selector = subpath.replace(/^#/, "");
    const range = selector.startsWith("^") ? blockRange(content, selector.slice(1)) : headingRange(lines, selector);
    return range ? lines.slice(range.start, range.end).join("\n") : null;
  }

  async getFile(fileName: string, _isMock: boolean): Promise<ArrayBuffer | null> {
    const file = this.resolve(fileName);
    if (this.opts.workflowBinaries) {
      const snapshot = file && this.opts.workflowBinaries.get(file.path);
      if (!snapshot) throw Error(`Attachment was not prepared for this workflow: ${fileName}`);
      return snapshot.slice(0);
    }
    return file ? this.app.vault.readBinary(file) : null;
  }

  async getCanvas(fileName: string, _isMock: boolean): Promise<string | null> {
    if (this.opts.workflowCanvases) return this.opts.workflowCanvases.get(fileName) ?? null;
    const file = this.app.metadataCache.getFirstLinkpathDest(fileName, this.opts.sourcePath ?? "");
    return file ? this.app.vault.cachedRead(file) : null;
  }

  editSelection(newContent: string, isMock: boolean): void {
    if (isMock || this.opts.mock) return;
    this.app.workspace?.activeEditor?.editor?.replaceSelection(this.opts.workflowText?.(newContent) ?? newContent);
  }

  /** Frozen or run-owned frontmatter; legacy callers use metadata cache without file IO. */
  private async frontmatter(noteName: string): Promise<Record<string, unknown> | null> {
    const file = this.resolve(noteName);
    if (!file) return null;
    if (this.opts.workflowProperties) {
      const own = this.propertyWrites.get(file.path);
      if (own) return structuredClone(Object.fromEntries(own));
      const body = this.bodyWrites.get(file.path);
      if (body !== undefined && FRONTMATTER.test(body)) return readFrontmatter(body);
      const snapshot = this.opts.workflowProperties.get(file.path);
      if (!snapshot && body === undefined) throw Error(`Properties were not prepared for this workflow: ${file.path}`);
      return structuredClone(snapshot ?? {});
    }
    const cache = this.app.metadataCache.getFileCache?.(file) as { frontmatter?: Record<string, unknown> } | null | undefined;
    return { ...(cache?.frontmatter ?? {}) };
  }

  async getPropertyOfNote(noteName: string, propertyName: string, yamlFormat = false): Promise<string | null> {
    const fm = await this.frontmatter(noteName).catch(() => null);
    if (!fm) return null;
    const v = fm[propertyName];
    // Missing: null, as upstream (its yaml.dump(undefined) threw and was caught).
    if (v === undefined) return null;
    if (typeof v === "string") return v;
    return yamlFormat ? toYaml(v) : JSON.stringify(v, null, 2);
  }

  async getAllPropertiesOfNote(noteName: string, yamlFormat = false): Promise<string | null> {
    const fm = await this.frontmatter(noteName).catch(() => null);
    if (!fm) return null;
    return yamlFormat ? toYaml(fm) : JSON.stringify(fm, null, 2);
  }

  async editPropertyOfNote(noteName: string, propertyName: string, newValue: string): Promise<void> {
    if (this.opts.mock) return;
    const file = this.editable(noteName);
    if (!file) return;
    const ownValue = newValue;
    const base = this.opts.workflowProperties ? await this.frontmatter(noteName).catch(() => ({})) : {};
    const frozenBody = this.bodyWrites.get(file.path) ?? this.opts.workflowSnapshots?.get(file.path);
    const frozenProperties = frozenBody !== undefined && FRONTMATTER.test(frozenBody) ? readFrontmatter(frozenBody) : base;
    newValue = this.opts.workflowText?.(newValue) ?? newValue;
    const parsed: string | string[] = newValue.startsWith("- ")
      ? newValue
          .split("\n")
          .map((item) => item.replace("- ", "").trim())
          .filter(Boolean)
      : newValue;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[propertyName] = parsed;
    });
    if (!this.opts.workflowProperties) return;
    const ownParsed = ownValue.startsWith("- ") ? ownValue.split("\n").map(item => item.replace("- ", "").trim()).filter(Boolean) : ownValue;
    const overlay = new Map(this.propertyWrites.get(file.path) ?? Object.entries(frozenProperties ?? {}));
    overlay.set(propertyName, ownParsed);
    const body = this.bodyWrites.get(file.path) ?? this.opts.workflowSnapshots?.get(file.path);
    if (body !== undefined) this.bodyWrites.set(file.path, withFrontmatter(body, Object.fromEntries(overlay)));
    this.propertyWrites.set(file.path, overlay);
  }

  async createNoteAtExistingPath(noteName: string, path?: string, content?: string): Promise<string | null> {
    const ownContent = content ?? "";
    if (content !== undefined) content = this.opts.workflowText?.(content) ?? content;
    let name = linkpathOf(noteName);
                                                                                                 
    const folder = path || this.opts.flowFolder;
    this.creatable(joinPath(folder, `${name}.md`));
    let i = 1;
    while (this.app.metadataCache.getFirstLinkpathDest(name, "")) {
      name = / \d+$/.test(name) ? name.replace(/ \d+$/, ` ${i}`) : `${name} ${i}`;
      i++;
    }
    const fullPath = this.creatable(joinPath(folder, `${name}.md`));
    if (!this.opts.mock) {
      await this.app.vault.create(fullPath, content ?? "");
      if (this.opts.workflowSnapshots) this.bodyWrites.set(fullPath, ownContent);
    }
    return `[[${fullPath}|${name}]]`;
  }

  async createNoteAtNewPath(noteName: string, path: string, content?: string): Promise<string> {
    const ownContent = content ?? "";
    if (content !== undefined) content = this.opts.workflowText?.(content) ?? content;
    const fullPath = this.creatable(joinPath(path, `${noteName}.md`));
    if (!this.opts.mock) {
      await this.app.vault.create(fullPath, content ?? "");
      if (this.opts.workflowSnapshots) this.bodyWrites.set(fullPath, ownContent);
    }
    return `[[${fullPath}|${noteName}]]`;
  }

  async getNotePath(noteName: string): Promise<string | null> {
    return this.resolve(noteName)?.path ?? null;
  }

  async createFolder(path: string): Promise<boolean> {
    const folder = this.creatable(path, true);
    if (this.app.vault.getAbstractFileByPath(folder)) return false;
    if (!this.opts.mock) await this.app.vault.createFolder(folder);
    return true;
  }

  async moveNote(noteName: string, _newPath: string): Promise<boolean> {
    throw new Error(`Mehrpele Flows never moves or renames notes (asked to move "${linkpathOf(noteName)}")`);
  }
}
