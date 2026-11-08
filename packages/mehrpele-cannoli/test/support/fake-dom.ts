// A tiny DOM for overlay tests (bun test has no DOM): just what frame-ui uses, plus a record of
// every element ever created so tests can check where each one ended up.

export class FakeNode {
  className = "";
  textContent: string | null = "";
  readonly attrs = new Map<string, string>();
  readonly cssProps: Record<string, string> = {};
  childNodes: FakeNode[] = [];
  parent: FakeNode | null = null;
  connected = true;
  /** Set on overlay layers. */
  layerId?: string;
  /** Set on host-owned nodes (svg.pele, .pele-mount). */
  hostOwned?: string;

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  get children(): FakeNode[] {
    return this.childNodes;
  }
  get isConnected(): boolean {
    return this.connected && (this.parent ? this.parent.isConnected : true);
  }
  get classList() {
    const self = this;
    return {
      contains: (c: string) => self.className.split(/\s+/).includes(c),
    };
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attrs) if (k.startsWith("data-")) out[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    if (this.layerId) out.layer = this.layerId;
    return out;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setCssProps(props: Record<string, string>): void {
    Object.assign(this.cssProps, props);
  }
  appendChild<T extends FakeNode>(child: T): T {
    child.parent = this;
    this.childNodes.push(child);
    return child;
  }
  replaceChildren(...nodes: FakeNode[]): void {
    for (const c of this.childNodes) c.parent = null;
    this.childNodes = [];
    for (const n of nodes) this.appendChild(n);
  }
  remove(): void {
    this.connected = false;
    if (this.parent) this.parent.childNodes = this.parent.childNodes.filter((c) => c !== this);
  }
  /** Descendants, depth first. */
  all(): FakeNode[] {
    return this.childNodes.flatMap((c) => [c, ...c.all()]);
  }
  /** `.class` selectors only. */
  querySelector(sel: string): FakeNode | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeNode[] {
    const cls = sel.replace(/^\./, "");
    return this.all().filter((n) => n.classList.contains(cls));
  }
  /** Text of this node and its descendants. */
  text(): string {
    return [this.textContent ?? "", ...this.childNodes.map((c) => c.text())].join("");
  }
}

export class FakeDocument {
  readonly created: FakeNode[] = [];
  createElement(tag: string): FakeNode {
    const n = new FakeNode(tag, this);
    this.created.push(n);
    return n;
  }
}

/** A frame surface: `.pele-host` holding `svg.pele`, `.pele-mount` and the overlay container. */
export function fakeSurface(doc = new FakeDocument()) {
  const host = new FakeNode("div", doc);
  const svg = host.appendChild(new FakeNode("svg", doc));
  svg.hostOwned = "svg.pele";
  const mount = host.appendChild(new FakeNode("div", doc));
  mount.hostOwned = ".pele-mount";
  const overlay = host.appendChild(new FakeNode("div", doc));
  const layers: FakeNode[] = [];
  return {
    doc,
    host,
    svg,
    mount,
    layers,
    createLayer: (layerId: string) => {
      const layer = overlay.appendChild(new FakeNode("div", doc));
      layer.layerId = layerId;
      layers.push(layer);
      return layer as unknown as HTMLElement;
    },
  };
}
