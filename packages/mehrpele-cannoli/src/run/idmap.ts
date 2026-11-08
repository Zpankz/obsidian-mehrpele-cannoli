                                                                                           
//
//   node  n_<id> (or a provenance canvas id)  -> <id>
//   group g_<id>                              -> <id> (the subgraph / cluster id)
//   edge  e_<a>_<b>_<k>                       -> L_<a>_<b>_<k> (Mermaid's DOM edge id, per-pair k)
//
// For-each copies (`<id>-<n>`, nested `-<n>-<m>`) map to their original. Ids that still do not
// map are counted, so the overlay can say how many updates it could not place.
import type { FrameProvenance } from "mehrpele-api";
import type { CannoliCanvas } from "../flows/translate";

export type MappedKind = "node" | "group" | "edge";
export interface Mapped {
  kind: MappedKind;
  /** Mermaid id: node id, subgraph id, or `L_<a>_<b>_<k>` for edges. */
  id: string;
}

const strip = (canvasId: string, prefix: string) => (canvasId.startsWith(prefix) ? canvasId.slice(prefix.length) : canvasId);

export class IdMap {
  private byCanvas = new Map<string, Mapped>();
  private byMermaid = new Map<string, string>();
  private unknown = new Set<string>();

  constructor(canvas: CannoliCanvas, provenance?: FrameProvenance | null) {
    const fromProv = new Map<string, string>();
    for (const [mid, p] of Object.entries(provenance?.nodes ?? {})) fromProv.set(p.canvasId, mid);
    for (const n of canvas.nodes) {
      const group = n.type === "group";
      const id = n.peleId ?? fromProv.get(n.id) ?? strip(n.id, group ? "g_" : "n_");
      this.byCanvas.set(n.id, { kind: group ? "group" : "node", id });
      this.byMermaid.set(id, n.id);
    }
    const perPair = new Map<string, number>();
    for (const e of canvas.edges) {
      const a = this.byCanvas.get(e.fromNode)?.id ?? strip(e.fromNode, "n_");
      const b = this.byCanvas.get(e.toNode)?.id ?? strip(e.toNode, "n_");
      const pair = `${a}_${b}`;
      const k = perPair.get(pair) ?? 0;
      perPair.set(pair, k + 1);
      const id = `L_${pair}_${k}`;
      this.byCanvas.set(e.id, { kind: "edge", id });
      this.byMermaid.set(id, e.id);
    }
  }

  /** The Mermaid object for a canvas (or run graph) id; null and counted when it has none. */
  resolve(canvasId: string): Mapped | null {
    let id = canvasId;
    for (;;) {
      const hit = this.byCanvas.get(id);
      if (hit) return hit;
      const base = id.replace(/-\d+$/, "");
      if (base === id) break;
      id = base;
    }
    this.unknown.add(canvasId);
    return null;
  }

  /** The canvas id drawn as Mermaid id `mermaidId`. */
  canvasIdOf(mermaidId: string): string | undefined {
    return this.byMermaid.get(mermaidId);
  }

  /** Distinct ids that `resolve` could not place. */
  get unknownCount(): number {
    return this.unknown.size;
  }

  get unknownIds(): string[] {
    return [...this.unknown];
  }
}
