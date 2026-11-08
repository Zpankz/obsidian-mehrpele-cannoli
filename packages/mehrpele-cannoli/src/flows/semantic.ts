                                                                                                  
// the same flow: geometry and Mermaid ids may differ (an embedded .canvas moved, or reconverted
// with new ids while the provenance canvasIds stayed), but nodes, edges, group membership and
// config are the same. Anything the key misses only costs a stop, so it errs towards "changed".
import type { IdMap } from "../run/idmap";
import type { CanvasNodeLike, Translation } from "./translate";

const NODE_KEYS = ["id", "type", "text", "file", "subpath", "url", "label", "color"] as const;
// fromEnd/toEnd: core isValidEdge reads the arrow ends, so they change what the flow does.
const EDGE_KEYS = ["fromNode", "toNode", "fromEnd", "toEnd", "label", "color"] as const;

interface Rect {
  x: number;
  y: number;
  r: number;
  b: number;
}
const rectOf = (n: CanvasNodeLike): Rect | null => {
  const [x, y, w, h] = [n.x, n.y, n.width, n.height].map(Number);
  return [x, y, w, h].every(Number.isFinite) ? { x, y, r: x + w, b: y + h } : null;
};
// Cannoli's own rules (core factory encloses/overlaps): membership and overlap decide groups.
const encloses = (a: Rect, b: Rect) => a.x <= b.x && a.y <= b.y && a.r >= b.r && a.b >= b.b;
const overlaps = (a: Rect, b: Rect) => a.x < b.r && a.r > b.x && a.y < b.b && a.b > b.y && !encloses(a, b) && !encloses(b, a);

export function semanticKey(t: Translation): string {
  const nodes = [...t.canvas.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const groups = nodes.filter((n) => n.type === "group").map((g) => [g.id, rectOf(g)] as const);
  const nodeKeys = nodes.map((n) => {
    const r = rectOf(n);
    const inside = r ? groups.filter(([id, g]) => id !== n.id && g && encloses(g, r)).map(([id]) => id) : [];
    const overlap = r ? groups.filter(([id, g]) => id !== n.id && g && overlaps(g, r)).map(([id]) => id) : [];
    return [...NODE_KEYS.map((k) => n[k] ?? null), inside, overlap];
  });
  // Canvas order, unsorted: the core keeps it and takes the first incoming write edge.
  const edgeKeys = t.canvas.edges.map((e) => JSON.stringify(EDGE_KEYS.map((k) => e[k] ?? null)));
  return JSON.stringify([t.type, t.config, nodeKeys, edgeKeys]);
}

/** A Mermaid id drawn through `from` -> the id the same canvas object has in `to` (else unchanged). */
export function remapId(from: IdMap, to: IdMap, id: string): string {
  if (from === to) return id;
  const canvasId = from.canvasIdOf(id);
  return (canvasId !== undefined && to.resolve(canvasId)?.id) || id;
}
