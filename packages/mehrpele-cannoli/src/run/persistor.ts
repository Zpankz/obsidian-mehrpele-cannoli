// RunViewPersistor: the engine's Persistor, kept in memory for the run view. It never writes the
                                                                                              
// runner subscribes to node-status events and reconciles once at the end.
import type { RunEvent } from "../flows/engine";

export type NodeStatus = "pending" | "executing" | "complete" | "rejected" | "error" | "warning" | "version-complete";

export interface NodeRow {
  id: string;
  label: string;
  kind: string;
  status: NodeStatus;
  message?: string;
}

interface NodeDataLike {
  id: string;
  text?: string;
  label?: string;
  file?: string;
  type?: string;
  cannoliData?: { text?: string; status?: string; kind?: string };
}
interface CanvasLike {
  nodes: NodeDataLike[];
}
interface GraphObjectLike {
  status?: unknown;
  kind?: unknown;
}

const STATUSES = new Set<NodeStatus>(["pending", "executing", "complete", "rejected", "error", "warning", "version-complete"]);
const asStatus = (s: unknown): NodeStatus => (STATUSES.has(s as NodeStatus) ? (s as NodeStatus) : "pending");

/** Redacted before it is cut: a key longer than the label would no longer match once truncated. */
function labelOf(n: NodeDataLike, redact: (text: string) => string): string {
  const raw = redact(n.cannoliData?.text || n.text || n.label || n.file || n.id);
  const line = raw.split("\n").find((l) => l.trim()) ?? n.id;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export class RunViewPersistor {
  private rows = new Map<string, NodeRow>();
  private labels: ReadonlyMap<string, string> = new Map();

  /** Keep user-authored labels when the execution plan contains private snapshot handles. */
  setLabels(labels: ReadonlyMap<string, string>): void { this.labels = labels; }
  private eventStatuses = new Map<string, NodeStatus>();
  private listeners = new Set<() => void>();
  private redact: (text: string) => string = (t) => t;

  /** Messages shown in the view and kept in records pass through this (keys removed). */
  setRedactor(fn: (text: string) => string): void {
    this.redact = fn;
  }

  /** Rows in canvas order. */
  list(): NodeRow[] {
    return [...this.rows.values()];
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Seeds the rows from the parsed canvas (also used before start, from the probe). */
  seed(canvas: CanvasLike): void {
    this.rows.clear();
    for (const n of canvas.nodes) {
      if (n.cannoliData?.kind === "group" && !n.label) continue;
      this.rows.set(n.id, { id: n.id, label: labelOf(this.labels.has(n.id) ? { ...n, text: this.labels.get(n.id), cannoliData: undefined } : n, this.redact), kind: n.cannoliData?.kind ?? "node", status: this.eventStatuses.get(n.id) ?? asStatus(n.cannoliData?.status) });
    }
    this.emit();
  }

  /** Events are authoritative over delayed batched Persistor snapshots. */
  onEvent(event: RunEvent): void {
    if (event.t !== "node-status") return;
    const status = asStatus(event.status);
    this.eventStatuses.set(event.id, status);
    const row = this.rows.get(event.id);
    if (!row || row.status === "error" || row.status === status) return;
    row.status = status;
    this.emit();
  }

  /** Copies statuses not already supplied by events; nodes and groups only. */
  sync(graph: Record<string, GraphObjectLike>): void {
    let changed = false;
    for (const row of this.rows.values()) {
      const o = graph[row.id];
      if (!o || row.status === "error" || this.eventStatuses.has(row.id)) continue; // an error reported by addError sticks
      const status = asStatus(o.status);
      if (row.status !== status) {
        row.status = status;
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  // ----- Persistor -----

  async start(canvasData: CanvasLike): Promise<void> {
    this.seed(canvasData);
  }

  async editNode(node: NodeDataLike): Promise<void> {
    const row = this.rows.get(node.id);
    if (!row) return;
    if (row.status !== "error") row.status = this.eventStatuses.get(node.id) ?? asStatus(node.cannoliData?.status ?? row.status);
    this.emit();
  }

  async editEdge(): Promise<void> {}

  async addError(nodeId: string, message: string): Promise<void> {
    const row = this.rows.get(nodeId);
    if (!row) return;
    row.status = "error";
    row.message = this.redact(message);
    this.emit();
  }

  async addWarning(nodeId: string, message: string): Promise<void> {
    const row = this.rows.get(nodeId);
    if (!row) return;
    row.status = "warning";
    row.message = this.redact(message);
    this.emit();
  }

  async editOriginalParallelGroupLabel(): Promise<void> {}

  setConfig(): void {}
}
