// An in-memory FrameHandle: a rendered diagram frame with node boxes and overlay layers.

import type { FrameHandle, FrameLang, FrameProvenance } from "../index";

/** A node box in overlay coordinates. */
type NodeBox = { x: number; y: number; width: number; height: number };

export interface FakeFrameInit {
  sourcePath?: string;
  fenceLine?: number;
  lang?: FrameLang;
  fenceRest?: string;
  diagramType?: string;
  source?: string;
  provenance?: FrameProvenance | null;
  /** Node boxes in overlay coordinates. */
  rects?: Record<string, NodeBox>;
  /**
   * Elements `frames.forElement` maps to this frame: each one, and anything it `contains`
   * (when the element has a `contains` method, e.g. a real DOM node).
   */
  elements?: HTMLElement[];
}

export class FakeFrame implements FrameHandle {
  readonly key: string;
  readonly sourcePath: string;
  readonly lang: FrameLang;
  readonly fenceRest: string;
  readonly diagramType: string;
  source: string;
  rects: Map<string, NodeBox>;
  readonly elements: HTMLElement[];
  renders = 0;
  /** Calls to `api.refreshActions(frame)`. */
  actionRefreshes = 0;
  refreshed: string[] = [];
  private prov: FrameProvenance | null;
  private layers = new Map<string, HTMLElement>();
  private connected = true;

  constructor(
    init: FakeFrameInit = {},
    private createLayer: (layerId: string) => HTMLElement,
  ) {
    this.sourcePath = init.sourcePath ?? "Note.md";
    this.key = `${this.sourcePath}#${init.fenceLine ?? 0}`;
    this.lang = init.lang ?? "mermaid";
    this.fenceRest = init.fenceRest ?? "";
    this.diagramType = init.diagramType ?? "flowchart";
    this.source = init.source ?? "flowchart LR\n  a --> b";
    this.prov = init.provenance ?? null;
    this.rects = new Map(Object.entries(init.rects ?? {}));
    this.elements = init.elements ?? [];
  }

  getSource(): string {
    return this.source;
  }

  provenance(): FrameProvenance | null {
    return this.prov;
  }

  nodeRect(id: string): DOMRect | null {
    const r = this.rects.get(id);
    if (!r || !this.connected) return null;
    // DOMRect-shaped plain object; bun test has no DOMRect constructor.
    return {
      ...r,
      top: r.y,
      left: r.x,
      right: r.x + r.width,
      bottom: r.y + r.height,
      toJSON: () => r,
    };
  }

  overlay(layerId: string): HTMLElement {
    let layer = this.layers.get(layerId);
    if (!layer) {
      layer = this.createLayer(layerId);
      this.layers.set(layerId, layer);
    }
    return layer;
  }

  /** The layers created so far, for assertions. */
  layerIds(): string[] {
    return [...this.layers.keys()];
  }

  /** Removes the layers owned by a feature: `featureId` itself and `featureId:*`. */
  removeLayers(featureId: string): void {
    for (const [id, layer] of [...this.layers]) {
      if (id === featureId || id.startsWith(`${featureId}:`)) {
        layer.remove();
        this.layers.delete(id);
      }
    }
  }

  refreshNode(id: string): void {
    this.refreshed.push(id);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Called by FakeHost.destroy. */
  markDestroyed(): void {
    this.connected = false;
    for (const layer of this.layers.values()) layer.remove();
  }
}
