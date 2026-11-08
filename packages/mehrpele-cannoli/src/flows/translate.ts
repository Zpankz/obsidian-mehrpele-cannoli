                                                                                                 
// presets Cannoli reads (`:::choice` -> `:::canvas3`), then the host's Pele converts the source
// with explicit edge sides. The engine never sees Mermaid, and this bundle never contains Pele.
import type { MermaidToCanvasResult } from "mehrpele-api";
import { type FlowConfig, parseFlowConfig, stripConfigLines } from "./fence";

// The aliases mirror cannoli-core's CannoliFactory maps with contentIsColorless off (the companion
// never sets it). test/translate.test.ts checks every entry against the real factory.

/** Node kinds: call (nodeColorMap Call), content (Content), http/search (getContentNodeType), ignore (red). */
export const NODE_ALIASES = { call: "3", content: "6", http: "2", search: "5", ignore: "1" } as const;
/** Edge kinds (edgeColorMap); ignore is red. */
export const EDGE_ALIASES = { config: "2", choice: "3", chat: "4", list: "5", field: "6", ignore: "1" } as const;
/** Group kinds (groupColorMap); ignore is red. */
export const GROUP_ALIASES = { foreach: "5", ignore: "1" } as const;
/** Edge label prefixes (edgePrefixMap), as edge aliases. */
export const EDGE_PREFIXES: Record<string, keyof typeof EDGE_ALIASES> = { "*": "config", "?": "choice", "@": "chat", "<": "list", "=": "field" };

export type ObjectKind = "node" | "edge" | "group";
const TABLES: Record<ObjectKind, Record<string, string>> = { node: NODE_ALIASES, edge: EDGE_ALIASES, group: GROUP_ALIASES };

/** The edge alias for a canvas edge colour, if Cannoli gives that colour a kind. */
export function edgeKindOfColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  return Object.entries(EDGE_ALIASES).find(([, n]) => n === color)?.[0];
}

export interface CanvasApiLike {
  mermaidToCanvas(src: string, opts?: object): MermaidToCanvasResult;
}

export interface CanvasNodeLike {
  id: string;
  type?: string;
  text?: string;
  file?: string;
  label?: string;
  color?: string;
  peleId?: string;
  [k: string]: unknown;
}
export interface CanvasEdgeLike {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
  color?: string;
  [k: string]: unknown;
}
export interface CannoliCanvas {
  nodes: CanvasNodeLike[];
  edges: CanvasEdgeLike[];
  metadata?: { pele?: { type?: string; fidelity?: string; dropped?: string[] } } & Record<string, unknown>;
}

export interface Translation {
  canvas: CannoliCanvas;
  /** The source handed to the host: config lines removed, aliases rewritten. */
  source: string;
  /** Diagram type as Pele parsed it ("flowchart", "state", "sequence", …). */
  type: string;
  fidelity: string;
  dropped: string[];
  /** Alias problems (wrong kind, shadowed by a classDef, conflicting kinds). */
  notes: string[];
  config: FlowConfig;
  configWarnings: string[];
}

/** Blanks every character but newlines, so lines and offsets stay put. */
const SPACE = (s: string) => s.replace(/[^\n]/g, " ");

const isComment = (line: string) => /^\s*%%/.test(line);

   
                                                                                                
                                                                                                 
                                                                                                   
                                                                         
   
function maskLines(lines: string[]): string[] {
  return lines
    .map((l) => (isComment(l) ? SPACE(l) : l))
    .join("\n")
    .replace(/"[^"]*"/g, SPACE)
    .replace(/\|[^|\n]*\|/g, SPACE)
                                                                                                             
    .replace(/\[[^\]]*\]|\([^)]*\)|\w\{[^}]*\}/g, (match) => /^\w\{/.test(match) ? match[0] + SPACE(match.slice(1)) : SPACE(match))
    .split("\n");
}

/**
 * Rewrites known aliases to `canvasN`. Only `:::alias` (nodes) and `class <ids> <alias>` statements
 * are touched; `canvasN`, unknown classes and user-defined classDefs are left alone.
 */
export function rewriteAliases(source: string): { source: string; notes: string[] } {
  const lines = source.split("\n");
  const masked = maskLines(lines);
  const edgeIds = new Set<string>();
  const groupIds = new Set<string>();
  const userClasses = new Set<string>();
  for (const m of masked) {
    for (const e of m.matchAll(/\b([A-Za-z_][\w]*)@(?=[-=.~<ox])/g)) edgeIds.add(e[1]);
    const sg = /^\s*subgraph\s+([^\s[]+)/.exec(m);
    if (sg) groupIds.add(sg[1]);
    const cd = /^\s*classDef\s+(\S+)/.exec(m);
    if (cd) for (const c of cd[1].split(",")) userClasses.add(c);
  }
  const kindOf = (id: string): ObjectKind => (edgeIds.has(id) ? "edge" : groupIds.has(id) ? "group" : "node");
  const notes: string[] = [];
  const noted = new Set<string>();
  const note = (text: string) => {
    if (!noted.has(text)) notes.push(text);
    noted.add(text);
  };
  const isAlias = (cls: string) => cls in NODE_ALIASES || cls in EDGE_ALIASES || cls in GROUP_ALIASES;
  /** Preset for `cls` on an object of `kind`, or null (left as is). */
  const presetFor = (cls: string, kind: ObjectKind, where: string): string | null => {
    if (!isAlias(cls)) return null;
    if (userClasses.has(cls)) {
      note(`"${cls}" is defined by a classDef in this flow, so it is not read as a Cannoli kind.`);
      return null;
    }
    const preset = TABLES[kind][cls];
    if (preset) return preset;
    note(`"${cls}" is not a ${kind} kind (${where}); it was left as a plain class.`);
    return null;
  };
  // Kind presets per object, to report conflicting kinds.
  const kinds = new Map<string, Set<string>>();
  const addKind = (id: string, preset: string) => {
    const set = kinds.get(id) ?? new Set<string>();
    set.add(preset);
    kinds.set(id, set);
  };

  const out = lines.map((line, i) => {
    const m = masked[i];
    if (!m.trim()) return line;
    const cls = /^(\s*)class\s+(\S+)\s+([\w-]+)\s*;?\s*$/.exec(m);
    if (cls) {
      const [, indent, idList, name] = cls as unknown as [string, string, string, string];
      const ids = idList.split(",").filter(Boolean);
      const preset = /^canvas([1-6])$/.exec(name)?.[1];
      if (preset) {
        for (const id of ids) addKind(id, preset);
        return line;
      }
      if (!isAlias(name)) return line;
      const byKind = new Map<ObjectKind, string[]>();
      for (const id of ids) byKind.set(kindOf(id), [...(byKind.get(kindOf(id)) ?? []), id]);
      const parts = [...byKind].map(([kind, kindIds]) => {
        const p = presetFor(name, kind, `class ${kindIds.join(",")}`);
        if (p) for (const id of kindIds) addKind(id, p);
        return `${indent}class ${kindIds.join(",")} ${p ? `canvas${p}` : name}`;
      });
      return parts.join("\n");
    }
    // `id:::alias` — node shorthand.
    let next = line;
    const hits = [...m.matchAll(/:::([\w-]+)/g)].reverse();
    for (const h of hits) {
      const name = h[1];
      // The node id is the last identifier before the (masked) shape text.
      const id = /([A-Za-z_][\w-]*)\s*$/.exec(m.slice(0, h.index))?.[1];
      const preset = /^canvas([1-6])$/.exec(name)?.[1];
      if (preset) {
        if (id) addKind(id, preset);
        continue;
      }
      const p = presetFor(name, "node", `${id ?? ""}:::${name}`);
      if (!p) continue;
      if (id) addKind(id, p);
      const at = h.index + 3;
      next = next.slice(0, at) + `canvas${p}` + next.slice(at + name.length);
    }
    return next;
  });
  for (const [id, set] of kinds) {
    if (set.size > 1) note(`${id} has more than one Cannoli kind (${[...set].map((p) => `canvas${p}`).join(", ")}); only one is kept.`);
  }
  return { source: out.join("\n"), notes };
}

                                                                                  
export function toCannoliCanvas(source: string, canvasApi: CanvasApiLike): Translation {
  const { config, warnings: configWarnings } = parseFlowConfig(source);
  const { source: rewritten, notes } = rewriteAliases(stripConfigLines(source));
  const result = canvasApi.mermaidToCanvas(rewritten, { explicitSides: true });
  const canvas = result.canvas as unknown as CannoliCanvas;
  const pele = canvas.metadata?.pele ?? {};
  return {
    canvas,
    source: rewritten,
    type: String(pele.type ?? "unknown"),
    // Fidelity is diagnostic metadata; retain JavaScript coercion for older hosts.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Preserve diagnostic coercion for older hosts.
    fidelity: String(result.fidelity ?? pele.fidelity ?? "full"),
    dropped: (result.dropped ?? []).map(String),
    notes,
    config,
    configWarnings,
  };
}
