// Diagram-native workflow preparation. No provider calls or writes; explicit calls only.
import { CannoliFactory } from "../../../cannoli-core/src/factory";
import { lintFlow } from "./lint";
import { cancellable } from "./cancel";
import { isAttachment } from "../run/attachments";
import MarkdownIt from "markdown-it";
import {
  toCannoliCanvas,
  type CanvasApiLike,
  type CannoliCanvas,
} from "./translate";
import { normaliseForEngine } from "../run/normalise";
import {
  type VaultApp,
  type TFileLike,
  safeVaultPath,
} from "../run/vault-file-manager";

const markdown = new MarkdownIt("commonmark");
const CALL = /^\s*\{\{flow:\[\[([^\]]+)\]\]\}\}\s*$/;
const CONTEXT = /\{\{context:\[\[([^\]]+)\]\](?:;hops=(\d+))?\}\}/g;
const DATA =
  /^\s*\{\{data:(base|graph):\[\[([^\]]+)\]\](?:;hops=(\d+))?\}\}\s*$/;
export interface WorkflowData {
  readBase(path: string, view: string, signal?: AbortSignal): Promise<unknown>;
  links(path: string): { from: string; to: string }[];
}
export interface PreparedWorkflow {
  root: CannoliCanvas;
  currentNote?: string;
  children: Map<string, CannoliCanvas>;
  reads: string[];
  literals: Map<string, string>;
  labels: Map<string, string>;
  maxBytes: number;
  imageLiterals: Map<string, string>;
  imageKeys?: Map<string, string>;
  snapshots: Map<string, string>;
  properties: Map<string, Record<string, unknown>>;
  metadata: Map<string, unknown>;
  bindings: Map<string, string>;
  binaries: Map<string, ArrayBuffer>;
  snapshotNotes(names: string[]): Promise<string[]>;
}
export interface PrepareOptions {
  app: VaultApp;
  sourcePath: string;
  currentNote?: string;
  canvas?: CanvasApiLike;
  data?: WorkflowData;
  signal?: AbortSignal;
  mock?: boolean;
  maxDepth?: number;
  maxFiles?: number;
  maxBytes?: number;
}
function assertCanvas(value: unknown): asserts value is CannoliCanvas {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as CannoliCanvas).nodes) ||
    !Array.isArray((value as CannoliCanvas).edges)
  )
    throw Error("Workflow must contain nodes and edges");
}
/** Use the backend's membership rules without parsing or executing inactive nodes. */
function executionNodes(canvas: CannoliCanvas) {
  const groups = canvas.nodes.filter(node => node.type === "group" && node.label === "cannoli");
  if (!groups.length) return canvas.nodes;
  const factory = new CannoliFactory(canvas as unknown as ConstructorParameters<typeof CannoliFactory>[0]);
  const members = new Set(groups.flatMap(group => factory.getMembersForGroup(group as unknown as Parameters<typeof factory.getMembersForGroup>[0])));
  return canvas.nodes.filter(node => members.has(node.id));
}

/** A note can contain many diagrams: a heading or following ^block-id selects one explicitly. */
export function diagramFromMarkdown(text: string, selector = ""): string {
  const tokens = markdown.parse(text, {}),
    lines = text.split("\n");
  let section = !selector,
    level = 7;
  const candidates: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "heading_open" && !selector.startsWith("^")) {
      const heading = tokens[i + 1]?.content ?? "",
        depth = Number(token.tag.slice(1));
      if (section && selector && depth <= level) section = false;
      if (heading.toLowerCase() === selector.toLowerCase()) {
        section = true;
        level = depth;
      }
    }
    if (
      token.type !== "fence" ||
      !/^(?:pele|mehrpele|mermaid)(?:\s|$)/.test(token.info)
    )
      continue;
    const selected = selector.startsWith("^")
      ? lines[token.map?.[1] ?? -1]?.trim() === selector
      : section;
    if (selected) candidates.push(token.content);
  }
  if (candidates.length !== 1)
    throw Error(
      `Nested workflow requires exactly one diagram${selector ? ` at #${selector}` : "; select a heading or block id"} (found ${candidates.length})`,
    );
  return candidates[0];
}
/** Resolve and snapshot the complete explicit call tree before confirmation/execution. */
export async function prepareWorkflow(
  input: unknown,
  options: PrepareOptions,
): Promise<PreparedWorkflow> {
  const { app, signal } = options;
  const depthLimit = options.maxDepth ?? 8,
    fileLimit = options.maxFiles ?? 64,
    byteLimit = options.maxBytes ?? 1_000_000;
  const children = new Map<string, CannoliCanvas>(),
    reads = new Set<string>(),
    loaded = new Map<string, string>();
  const literals = new Map<string, string>();
  const properties = new Map<string, Record<string, unknown>>();
  const metadata = new Map<string, unknown>();
  const bindings = new Map<string, string>();
  const binaries = new Map<string, ArrayBuffer>();
  const labels = new Map<string, string>();
  const capture = (value: string) =>
    captureWorkflowData(value, { literals, maxBytes: byteLimit });
  const imageLiterals = new Map<string, string>();
  let generatedBytes = 0;
  let currentNote: { file: TFileLike; selector: string } | undefined;
  const noteOrigins = new Set<string>();
  let bytes = 0,
    serial = 0;
  const check = () => {
    if (signal?.aborted) throw Error("Workflow stopped during preparation");
  };
  function resolve(
    link: string,
    origin: string,
    pin = true,
  ): { file: TFileLike; selector: string } {
    const name = link.split("|")[0].trim(),
      hash = name.indexOf("#");
    const path = hash < 0 ? name : name.slice(0, hash),
      selector = hash < 0 ? "" : name.slice(hash + 1);
    const file = app.metadataCache.getFirstLinkpathDest(path || origin, origin);
    if (!file || !safeVaultPath(file.path, app.vault.configDir))
      throw Error(`Workflow reference not available: ${name}`);
    if (pin) bind(file, origin, path || origin);
    return { file, selector };
  }
  function bind(file: TFileLike, origin: string, name: string) {
    bindings.set(`${origin}\0${name}`, file.path);
    bindings.set(`${origin}\0${file.path}`, file.path);
    if (/\.md$/i.test(file.path)) bindings.set(`${origin}\0${file.path.slice(0, -3)}`, file.path);
  }
  async function read(file: TFileLike): Promise<string> {
    check();
    reads.add(file.path);
    if (reads.size > fileLimit) throw Error("Workflow file limit exceeded");
    const prior = loaded.get(file.path);
    if (prior !== undefined) return prior;
    const text = await cancellable(() => app.vault.cachedRead(file), signal);
    check();
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > byteLimit) throw Error("Workflow context byte limit exceeded");
    loaded.set(file.path, text);
    const cache = app.metadataCache.getFileCache?.(file) as
      | { frontmatter?: Record<string, unknown> }
      | undefined;
    properties.set(file.path, structuredClone(cache?.frontmatter ?? {}));
    metadata.set(file.path, structuredClone(cache));
    return text;
  }
  async function snapshotNote(
    name: string,
    origin: string,
    depth = 0,
    seen = new Set<string>(),
  ): Promise<void> {
    check();
    const path = name.split("|")[0].split("#")[0];
    const file = app.metadataCache.getFirstLinkpathDest(path, origin);
    if (!file) return;
    safeVaultPath(file.path, app.vault.configDir);
    bind(file, origin, path);
    if (seen.has(file.path)) return;
    seen.add(file.path);
    if (options.mock) {
      if (file.extension.toLowerCase() === "md" && !properties.has(file.path)) {
        if (properties.size >= fileLimit) throw Error("Workflow file limit exceeded");
        const cache = app.metadataCache.getFileCache?.(file) as { frontmatter?: Record<string, unknown> } | null | undefined;
        const frontmatter = cache?.frontmatter ?? {};
        bytes += new TextEncoder().encode(JSON.stringify(frontmatter)).byteLength;
        if (bytes > byteLimit) throw Error("Workflow property byte limit exceeded");
        properties.set(file.path, structuredClone(frontmatter));
      }
      return;
    }
    if (depth > depthLimit) throw Error("Embedded note depth exceeded");
    reads.add(file.path);
    if (reads.size > fileLimit) throw Error("Workflow file limit exceeded");
    if (file.extension.toLowerCase() !== "md") {
      if (!binaries.has(file.path)) {
        const content = await cancellable(
          () => app.vault.readBinary(file),
          signal,
        );
        check();
        bytes += content.byteLength;
        if (bytes > byteLimit)
          throw Error("Workflow attachment byte limit exceeded");
        binaries.set(file.path, content);
      }
      return;
    }
    const text = await read(file);
    for (const match of text.matchAll(/!\[\[([\s\S]*?)\]\]/g))
      await snapshotNote(match[1], file.path, depth + 1, seen);
  }
  const snapshotNotes = async (names: string[]) => {
    const seen = new Set<string>();
    for (const name of names)
      await snapshotNote(name, options.sourcePath, 0, seen);
    return [...reads].sort();
  };
  function links(text: string, origin: string): string[] {
    const refs: string[] = [];
    for (const token of markdown.parse(text, {})) {
      if (token.type !== "inline") continue;
      for (const inline of token.children ?? []) {
        if (inline.type === "text")
          for (const match of inline.content.matchAll(/!?\[\[([^\]]+)\]\]/g))
            refs.push(match[1]);
        if (inline.type === "link_open") {
          const href = inline.attrGet("href");
          if (href && !/^[a-z][\w+.-]*:|^\/\//i.test(href)) {
            try {
              refs.push(decodeURIComponent(href));
            } catch {
              throw Error("Invalid Markdown link encoding");
            }
          }
        }
      }
    }
    return [...new Set(refs)].flatMap(ref => {
      try {
        const file = resolve(ref, origin, false).file;
        return file.extension.toLowerCase() === "md" ? [file.path] : [];
      } catch (error) {
        if (isAttachment(ref.split("|")[0].split("#")[0])) return [];
        throw error;
      }
    });
  }
  async function context(
    link: string,
    origin: string,
    hops: number,
  ): Promise<string> {
    if (hops > depthLimit) throw Error("Context traversal depth exceeded");
    const start = resolve(link, origin);
    if (start.file.extension.toLowerCase() !== "md") throw Error("Markdown context requires a Markdown note");
    if (options.mock)
      return `## [[${start.file.path}]]\nMock workflow context.`;
    const queue = [{ file: start.file, selector: start.selector, depth: 0 }],
      seen = new Set<string>(),
      parts: string[] = [];
    while (queue.length) {
      const item = queue.shift()!;
      if (seen.has(item.file.path)) continue;
      seen.add(item.file.path);
      const text = await read(item.file);
      // Native subpath extraction is delegated to the existing file manager at execution;
      // context snapshots use a complete note so their traversed links are visible together.
      if (item.selector)
        throw Error(
          "Context traversal currently requires a whole note; use a normal heading reference for a section",
        );
      parts.push(`## [[${item.file.path}]]\n${text}`);
      if (item.depth < hops)
        for (const path of links(text, item.file.path))
          queue.push({
            file: resolve(path, item.file.path).file,
            selector: "",
            depth: item.depth + 1,
          });
    }
    return parts.join("\n\n");
  }
  async function graph(
    link: string,
    origin: string,
    hops: number,
  ): Promise<unknown> {
    if (!options.data) throw Error("Graph data adapter is unavailable");
    if (hops > depthLimit) throw Error("Graph traversal depth exceeded");
    const root = resolve(link, origin).file.path,
      queue = [{ path: root, depth: 0 }],
      nodes = new Set<string>(),
      edges = new Map<string, { from: string; to: string }>();
    while (queue.length) {
      check();
      const item = queue.shift()!;
      if (nodes.has(item.path)) continue;
      nodes.add(item.path);
      reads.add(item.path);
      if (reads.size > fileLimit) throw Error("Workflow file limit exceeded");
      if (item.depth < hops)
        for (const edge of options.data.links(item.path)) {
          const from = resolve(edge.from, item.path).file.path;
          const to = resolve(edge.to, item.path).file.path;
          if (from !== item.path && to !== item.path) continue;
          edges.set(JSON.stringify([from, to]), { from, to });
          queue.push({ path: from === item.path ? to : from, depth: item.depth + 1 });
        }
    }
    return { nodes: [...nodes].sort().map((path) => ({ path })), edges: [...edges.values()].sort((a,b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)) };
  }
  async function compile(
    value: unknown,
    origin: string,
    stack: string[],
  ): Promise<CannoliCanvas> {
    check();
    assertCanvas(value);
    // Charge every generated plan before descending. Unique-file read limits do not
    // bound repeated call expansion, and a final size check alone is too late.
    generatedBytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (generatedBytes > byteLimit) throw Error("Generated workflow byte limit exceeded");
    const canvas = structuredClone(value);
    const activeNodes = executionNodes(canvas);
    for (const node of activeNodes) {
      if (stack.length === 1)
        labels.set(node.id, node.text ?? node.file ?? node.label ?? node.id);
      check();
      if (node.color === "1") continue;
      const explicit =
        typeof node.text === "string" ? CALL.exec(node.text) : null;
      const legacy =
        node.type === "file" &&
        node.color === "2" &&
        typeof node.file === "string" &&
        /\.canvas$/i.test(node.file)
          ? node.file
          : null;
      if (explicit || legacy) {
        const target = resolve(explicit?.[1] ?? legacy!, origin),
          identity = target.file.path + "#" + target.selector;
        if (stack.includes(identity))
          throw Error(
            `Recursive workflow call: ${[...stack, identity].join(" → ")}`,
          );
        if (stack.length >= depthLimit)
          throw Error("Nested workflow depth exceeded");
        const text = await read(target.file);
        let nested: unknown;
        if (target.file.extension === "canvas") nested = JSON.parse(text);
        else if (target.file.extension === "md") {
          if (!options.canvas)
            throw Error("Nested Pele workflows require the Mehrpele host");
          const translation = toCannoliCanvas(
            diagramFromMarkdown(text, target.selector),
            options.canvas,
          );
          const lint = lintFlow(translation);
          if (lint.blocked || translation.dropped.length)
            throw Error(
              `Nested diagram is not an executable workflow: ${lint.issues.map((issue) => issue.message).join("; ")}`,
            );
          nested = translation.canvas;
        } else
          throw Error(
            "Only Pele diagrams and canvases are executable workflows; Bases and graphs are data",
          );
        const key = `__pele_workflow_${++serial}.canvas`;
        const child = await compile(nested, target.file.path, [
          ...stack,
          identity,
        ]);
        child.metadata = {
          ...child.metadata,
          workflowSource: target.file.path,
        };
        children.set(key, child);
        node.type = "file";
        node.file = key;
        node.color = "2";
        delete node.text;
        delete node.subpath;
        continue;
      }
      if (typeof node.text === "string") {
        const data = DATA.exec(node.text);
        if (data) {
          const target = resolve(data[2], origin);
          let result: unknown;
          if (options.mock) result = { representation: "mock", rows: [] };
          else if (data[1] === "base") {
            await read(target.file);
            if (!options.data) throw Error("Bases data adapter is unavailable");
            result = await cancellable(
              () =>
                options.data!.readBase(
                  target.file.path,
                  target.selector,
                  signal,
                ),
              signal,
            );
            check();
          } else result = await graph(data[2], origin, Number(data[3] ?? 1));
          node.text = capture(JSON.stringify(result, null, 2));
          node.color = "6";
          bytes += new TextEncoder().encode(literals.get(node.text)).byteLength;
          if (bytes > byteLimit)
            throw Error("Workflow data byte limit exceeded");
        } else {
          const matches = [...node.text.matchAll(CONTEXT)];
          let text = node.text;
          for (const m of matches.reverse())
            text =
              text.slice(0, m.index) +
              capture(await context(m[1], origin, Number(m[2] ?? 0))) +
              text.slice(m.index + m[0].length);
          node.text = text;
          if (
            matches.length === 1 &&
            matches[0][0].trim() === valueNodeText(value, node.id).trim()
          )
            node.color = "6";
        }
      }
      if (stack.length > 1 && typeof node.text === "string" && /\{\{NOTE[^\w{}\r\n]*\}\}/.test(node.text)) {
        if (!currentNote) {
          if (!options.currentNote) throw Error("Nested NOTE requires an existing current note");
          currentNote = resolve(options.currentNote, options.sourcePath);
          if (currentNote.file.extension.toLowerCase() !== "md") throw Error("Nested NOTE requires an existing Markdown note");
          await snapshotNote(currentNote.file.path, options.sourcePath);
        }
        noteOrigins.add(origin);
      }
      // Child note reads/writes retain their own file-relative resolution at execution.
      if (origin !== options.sourcePath) {
        if (node.type === "file" && typeof node.file === "string")
          node.file = resolve(node.file, origin).file.path;
        if (typeof node.text === "string")
          node.text = node.text.replace(
            /\[\[([^\]]+)\]\]/g,
            (_all, ref: string, offset: number) => {
              const prefix = node.text!.slice(0, offset);
              if (!prefix.endsWith("{{") && !prefix.endsWith("!")) return _all;
              const t = resolve(ref, origin);
              return `[[${t.file.path}${t.selector ? "#" + t.selector : ""}]]`;
            },
          );
      }
    }
    for (const node of activeNodes) {
      if (node.color === "1") continue;
      if (
        node.type === "file" &&
        typeof node.file === "string" &&
        /\.md$/i.test(node.file)
      )
        await snapshotNote(node.file, origin);
      if (typeof node.text === "string") {
        for (const match of node.text.matchAll(/!\[\[([\s\S]*?)\]\]/g))
          await snapshotNote(match[1], origin);
        for (const match of node.text.matchAll(
          /\{\{\[\[([^\]]+)\]\][^{}]*\}\}/g,
        ))
          await snapshotNote(match[1], origin);
      }
    }
    return normaliseForEngine(canvas);
  }
  const root = await compile(input, options.sourcePath, [
    options.sourcePath + "#",
  ]);
  // Bind after all ordinary references are canonicalized, so an identically
  // named child-local file cannot overwrite the inherited current-note identity.
  if (currentNote) for (const origin of noteOrigins) bind(currentNote.file, origin, currentNote.file.path);
  const expandedBytes = new TextEncoder().encode(
    JSON.stringify([root, ...children.values(), ...literals.values()]),
  ).byteLength;
  if (expandedBytes > byteLimit)
    throw Error("Expanded workflow byte limit exceeded");
  return {
    root,
    currentNote: currentNote ? currentNote.file.path + (currentNote.selector ? "#" + currentNote.selector : "") : undefined,
    children,
    literals,
    labels,
    maxBytes: byteLimit,
    imageLiterals,
    reads: [...reads].sort(),
    snapshots: loaded,
    properties,
    metadata,
    bindings,
    binaries,
    snapshotNotes,
  };
}
function valueNodeText(value: CannoliCanvas, id: string): string {
  return value.nodes.find((n) => n.id === id)?.text ?? "";
}

/** Restore image lexemes only at output/transport boundaries, after image extraction. */
export function restoreWorkflowImages(content: string, workflow: Pick<PreparedWorkflow, "imageLiterals" | "maxBytes">): string {
  // The backslash in each opaque key records JSON stringification naturally:
  // each escaping pass doubles it. Decode its value at that same escape depth.
  const pattern = /@@PELE_IMAGE_(\\+)([a-f0-9-]+)@@/g;
  const values = new Map<string, string>();
  for (const match of content.matchAll(pattern)) {
    let value = workflow.imageLiterals.get(`@@PELE_IMAGE_\\${match[2]}@@`);
    if (value === undefined || values.has(match[0])) continue;
    const depth = Math.log2(match[1].length);
    if (!Number.isInteger(depth)) throw Error("Invalid workflow image literal encoding");
    for (let i = 0; i < depth; i++) value = JSON.stringify(value).slice(1,-1);
    values.set(match[0], value);
  }
  return expandData(content, pattern, values, workflow.maxBytes, value => value);
}

function expandData(content: string, pattern: RegExp, values: Map<string, string>, maxBytes: number | undefined, transform: (value: string) => string): string {
  let bytes = new TextEncoder().encode(content).byteLength;
  if (maxBytes !== undefined && bytes > maxBytes) throw Error("Expanded workflow data byte limit exceeded");
  return content.replace(pattern, key => {
    const value = values.get(key);
    if (value === undefined) return key;
    const replacement = transform(value);
    bytes += new TextEncoder().encode(replacement).byteLength - key.length;
    if (maxBytes !== undefined && bytes > maxBytes) throw Error("Expanded workflow data byte limit exceeded");
    return replacement;
  });
}

/** Restore data after template parsing; retain image provenance until extraction is over. */
export function restoreWorkflowData(
  content: string,
  workflow: Pick<PreparedWorkflow, "literals"> & { maxBytes?: number; imageLiterals?: Map<string, string>; imageKeys?: Map<string, string> },
  options: { json?: boolean; protectImages?: boolean } = {},
): string {
  return expandData(content, /@@PELE_DATA_[a-f0-9-]+@@/g, workflow.literals, workflow.maxBytes, value => {
    if (options.protectImages && workflow.imageLiterals) {
      value = value.replace(/!\[\[[\s\S]*?\]\]|!\[.*?\]\(.*?\)/g, image => {
        const keys = workflow.imageKeys ??= new Map([...workflow.imageLiterals!].map(([key,value]) => [value,key]));
        const prior = keys.get(image);
        if (prior) return prior;
        const key = `@@PELE_IMAGE_\\${crypto.randomUUID()}@@`;
        workflow.imageLiterals!.set(key, image);
        keys.set(image,key);
        return key;
      });
    }
    return options.json ? JSON.stringify(value).slice(1, -1) : value;
  });
}

/** Input arguments cross another parser boundary when a child Run is constructed. */
export function captureWorkflowData(
  value: string,
  workflow: Pick<PreparedWorkflow, "literals" | "maxBytes">,
): string {
  for (const [key, stored] of workflow.literals)
    if (stored === value) return key;
  const size = [...workflow.literals.values()].reduce(
    (n, text) => n + new TextEncoder().encode(text).byteLength,
    0,
  );
  if (size + new TextEncoder().encode(value).byteLength > workflow.maxBytes)
    throw Error("Workflow runtime data byte limit exceeded");
  const key = `@@PELE_DATA_${crypto.randomUUID()}@@`;
  workflow.literals.set(key, value);
  return key;
}
