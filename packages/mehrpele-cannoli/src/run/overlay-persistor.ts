                                                                                                    
// to Mermaid ids, throttles what the overlay draws, and tees every call to the RunViewPersistor so
// the run view and records stay as they were.
//
// Throttle, per Mermaid id:
//   - writes are coalesced into one animation-frame callback;
//   - at most 4 writes per second (one per 250 ms);
//   - a node shown as executing stays executing for at least 300 ms;
//   - text-only changes (the preview) are flushed every 250 ms.
// The clock and scheduler are injected, so tests drive it with fake timers.
//
// Live status and preview updates come from RunEventBus, including mock runs.
// Persistor callbacks retain accepted text and diagnostics absent from that event contract.
import type { RunEvent } from "../flows/engine";
import type { IdMap, MappedKind } from "./idmap";
import type { NodeStatus, RunViewPersistor } from "./persistor";

export type Cancel = () => void;
export interface Scheduler {
  now(): number;
  /** Runs `cb` on the next animation frame. */
  frame(cb: () => void): Cancel;
  timeout(cb: () => void, ms: number): Cancel;
}

/** What one badge shows. */
export interface BadgeState {
  /** Mermaid id (node, subgraph, or `L_…` edge id). */
  id: string;
  kind: MappedKind;
  status: NodeStatus;
  /** Error or warning text, redacted. */
  message?: string;
  /** First line of the node's current text, redacted. */
  preview?: string;
}

export const WRITE_INTERVAL_MS = 250;
export const MIN_EXECUTING_MS = 300;
export const TEXT_FLUSH_MS = 250;

/** The CSS class for a status (styles.css `mpc-s-*`). */
export const statusClass = (s: NodeStatus): string => `mpc-s-${s}`;

const STATUSES = new Set<NodeStatus>(["pending", "executing", "complete", "rejected", "error", "warning", "version-complete"]);
const asStatus = (s: unknown): NodeStatus | null => (STATUSES.has(s as NodeStatus) ? (s as NodeStatus) : null);

/** One badge stands for an object and all its for-each copies: the most telling status wins. */
const PRIORITY: Record<NodeStatus, number> = {
  error: 6,
  executing: 5,
  warning: 4,
  pending: 3,
  complete: 2,
  "version-complete": 2,
  rejected: 1,
};

function previewOf(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const line = text.split("\n").find((l) => l.trim());
  if (!line) return undefined;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

interface NodeLike {
  id: string;
  type?: string;
  text?: string;
  cannoliData?: { text?: string; status?: string };
}
interface EdgeLike {
  id: string;
  cannoliData?: { status?: string };
}

interface Slot {
  kind: MappedKind;
  /** canvas id (incl. copies) -> status */
  parts: Map<string, NodeStatus>;
  /** canvas ids whose error came from addError: sync does not clear it. */
  sticky: Set<string>;
  message?: string;
  preview?: string;
  shown?: BadgeState;
  lastWrite: number;
  executingSince: number;
  /** A part became executing and the badge has not shown it yet. */
  owesExecuting: boolean;
  timer?: Cancel;
}

export interface OverlayPersistorOptions {
  idMap: IdMap;
  /** Receives the badges that changed, once per animation frame. */
  sink(changed: BadgeState[]): void;
  scheduler: Scheduler;
  /** The run view's persistor; every call is forwarded to it. */
  view?: RunViewPersistor;
}

export class OverlayPersistor {
  private slots = new Map<string, Slot>();
  private dirty = new Set<string>();
  private textPending = new Set<string>();
  private frameCancel: Cancel | null = null;
  private textCancel: Cancel | null = null;
  private redact: (t: string) => string = (t) => t;
  private disposed = false;
  private eventIds = new Set<string>();
  private streamedIds = new Set<string>();
  private streams = new Map<string, { id: string; text: string }>();
  /** Seeded canvas ids the run has not reported yet. */
  private placeholders = new Set<string>();

  constructor(private readonly opts: OverlayPersistorOptions) {}

  setRedactor(fn: (t: string) => string): void {
    this.redact = fn;
    this.opts.view?.setRedactor(fn);
  }

  /** Marks every mapped node and group pending (before the run starts). */
  seed(canvas: { nodes: Array<{ id: string }> }): void {
    for (const n of canvas.nodes) {
      this.update(n.id, (s, cid) => this.setPart(s, cid, "pending"));
      this.placeholders.add(n.id);
    }
  }

  /** Badges as last written. */
  shown(): BadgeState[] {
    return [...this.slots.values()].flatMap((s) => (s.shown ? [s.shown] : []));
  }

  /** Distinct run ids the IdMap could not place on the diagram. */
  get unknownCount(): number {
    return this.opts.idMap.unknownCount;
  }

  /** A lint-style warning when some run objects could not be placed. */
  warnings(): string[] {
    const n = this.unknownCount;
    if (!n) return [];
    const ids = this.opts.idMap.unknownIds.slice(0, 5).join(", ");
    return [`${n} run object${n === 1 ? "" : "s"} could not be placed on the diagram (${ids}${n > 5 ? ", …" : ""}).`];
  }

  /** The runner independently feeds the run view; this observer owns only badges. */
  onEvent(event: RunEvent): void {
    if (this.disposed) return;
    if (event.t === "node-status") {
      const status = asStatus(event.status);
      if (!status) return;
      this.eventIds.add(event.id);
      this.update(event.id, (s, cid) => { if (!s.sticky.has(cid)) this.setPart(s, cid, status); });
    } else if (event.t === "text-delta") {
      const part = this.streams.get(event.callId) ?? { id: event.id, text: "" };
      part.text += event.text;
      this.streamedIds.add(event.id);
      this.streams.set(event.callId, part);
      this.update(event.id, s => { s.preview = this.previewOf(part.text) ?? s.preview; });
    } else if (event.t === "model-finish") this.streams.delete(event.callId);
    else if (event.t === "run-finish") this.streams.clear();
  }

  /** Final fallback for objects not already covered by status events. */
  sync(graph: Record<string, { status?: unknown }>): void {
    this.opts.view?.sync(graph);
    for (const [cid, o] of Object.entries(graph)) {
      const status = asStatus(o?.status);
      if (!status || this.eventIds.has(cid)) continue;
      this.update(cid, (s) => {
        if (s.sticky.has(cid)) return;
        this.setPart(s, cid, status);
      });
    }
  }

     
                                                                                              
                                                                          
     
  unfinished(): void {
    for (const s of this.slots.values()) {
      let changed = false;
      for (const [cid, st] of s.parts) {
        if (st !== "executing") continue;
        s.parts.set(cid, "pending");
        changed = true;
      }
      if (changed) s.owesExecuting = false;
    }
  }

  /** Writes everything pending now, ignoring the throttle (the run ended). */
  flush(): void {
    for (const s of this.slots.values()) {
      s.timer?.();
      s.timer = undefined;
    }
    this.textCancel?.();
    this.textCancel = null;
    for (const id of this.slots.keys()) this.dirty.add(id);
    this.frameCancel?.();
    this.frameCancel = null;
    this.write();
  }

  /**
   * Calls `done` once every queued write has landed: after `flush()` at run end, a node that ran
   * between two frames still owes its executing flash and the final status after it. Disposing
   * before then would leave that badge executing for good.
   */
  settle(done: () => void): void {
    const check = (): void => {
      if (this.disposed) return;
      const busy = this.frameCancel || this.textCancel || [...this.slots.values()].some((s) => s.timer);
      if (busy) this.opts.scheduler.timeout(check, WRITE_INTERVAL_MS / 5);
      else done();
    };
    check();
  }

  dispose(): void {
    this.disposed = true;
    this.streams.clear();
    this.eventIds.clear();
    this.streamedIds.clear();
    for (const s of this.slots.values()) s.timer?.();
    this.textCancel?.();
    this.frameCancel?.();
    this.textCancel = this.frameCancel = null;
  }

  /** Core flushes persistence batches, while the UI owns animation timing. Keep
   * the explicit overlay flush out of the engine's optional Persistor.flush hook.
   */
  asPersistor() {
    return {
      start: (canvas: { nodes: NodeLike[] }) => this.start(canvas),
      editNode: (node: NodeLike) => this.editNode(node),
      editEdge: (edge: EdgeLike) => this.editEdge(edge),
      addError: (id: string, message: string) => this.addError(id, message),
      addWarning: (id: string, message: string) => this.addWarning(id, message),
      editOriginalParallelGroupLabel: () => this.editOriginalParallelGroupLabel(),
      setConfig: () => this.setConfig(),
    };
  }

  // ----- Persistor -----

  async start(canvasData: { nodes: NodeLike[] }): Promise<void> {
    await this.opts.view?.start(canvasData);
    for (const n of canvasData.nodes) {
      this.update(n.id, (s, cid) => {
        if (!this.eventIds.has(cid)) this.setPart(s, cid, asStatus(n.cannoliData?.status) ?? "pending");
        if (!this.streamedIds.has(cid)) s.preview = this.previewOf(n.cannoliData?.text ?? n.text) ?? s.preview;
      });
    }
  }

  async editNode(node: NodeLike): Promise<void> {
    await this.opts.view?.editNode(node);
    this.update(node.id, (s, cid) => {
      const st = asStatus(node.cannoliData?.status);
      if (st && !s.sticky.has(cid) && !this.eventIds.has(cid)) this.setPart(s, cid, st);
      const p = this.previewOf(node.cannoliData?.text ?? node.text);
      if (p !== undefined && !this.streamedIds.has(cid)) s.preview = p;
    });
  }

  async editEdge(edge: EdgeLike): Promise<void> {
    await (this.opts.view?.editEdge as ((e: unknown) => Promise<void>) | undefined)?.call(this.opts.view, edge);
    this.update(edge.id, (s, cid) => {
      const st = asStatus(edge.cannoliData?.status);
      if (st && !this.eventIds.has(cid) && !s.sticky.has(cid)) this.setPart(s, cid, st);
    });
  }

  async addError(nodeId: string, message: string): Promise<void> {
    await this.opts.view?.addError(nodeId, message);
    this.update(nodeId, (s, cid) => {
      this.setPart(s, cid, "error");
      s.sticky.add(cid);
      s.message = this.redact(message);
    });
  }

  async addWarning(nodeId: string, message: string): Promise<void> {
    await this.opts.view?.addWarning(nodeId, message);
    this.update(nodeId, (s, cid) => {
      if (!s.sticky.has(cid)) this.setPart(s, cid, "warning");
      s.message = this.redact(message);
    });
  }

  async editOriginalParallelGroupLabel(): Promise<void> {
    await this.opts.view?.editOriginalParallelGroupLabel();
  }

  setConfig(): void {
    this.opts.view?.setConfig();
  }

  /** Redacts the whole text first: a key longer than the preview would no longer match once cut. */
  private previewOf(text: unknown): string | undefined {
    return previewOf(typeof text === "string" ? this.redact(text) : text);
  }

  // ----- throttle -----

  private update(canvasId: string, mutate: (slot: Slot, canvasId: string) => void): void {
    if (this.disposed) return;
    const mapped = this.opts.idMap.resolve(canvasId);
    if (!mapped) return;
    let slot = this.slots.get(mapped.id);
    if (!slot) {
      slot = { kind: mapped.kind, parts: new Map(), sticky: new Set(), lastWrite: -Infinity, executingSince: -Infinity, owesExecuting: false };
      this.slots.set(mapped.id, slot);
    }
    // The factory drops a for-each original and runs only its `-n` copies: once a copy is known,
    // the original's seeded pending part would outrank every finished copy, so it goes. An
    // original the run does report is a real part again (sync re-adds it every pass).
    const original = this.opts.idMap.canvasIdOf(mapped.id);
    if (original !== undefined) {
      if (canvasId === original) this.placeholders.delete(canvasId);
      else if (this.placeholders.delete(original)) slot.parts.delete(original);
    }
    mutate(slot, canvasId);
    this.schedule(mapped.id, slot);
  }

  private setPart(s: Slot, canvasId: string, status: NodeStatus): void {
    const prev = s.parts.get(canvasId);
    if (status === "executing" && prev !== "executing") s.owesExecuting = true;
    // pending -> complete with no executing seen: it ran between two looks (a mock run, seen only
                                                                    
    if (prev === "pending" && (status === "complete" || status === "version-complete")) s.owesExecuting = true;
    s.parts.set(canvasId, status);
  }

  private want(id: string, s: Slot): BadgeState | null {
    let status: NodeStatus | null = null;
    for (const p of s.parts.values()) if (!status || PRIORITY[p] > PRIORITY[status]) status = p;
    if (!status) return null;
    return {
      id,
      kind: s.kind,
      status,
      ...(s.message && (status === "error" || status === "warning") ? { message: s.message } : {}),
      ...(s.preview ? { preview: s.preview } : {}),
    };
  }

  private schedule(id: string, s: Slot): void {
    const want = this.want(id, s);
    if (!want) return;
    const shown = s.shown;
    if (shown && shown.status === want.status && shown.message === want.message) {
      if (shown.preview !== want.preview) this.queueText(id);
      return;
    }
    this.gate(id, s);
  }

  /** Marks `id` dirty now, or when its write interval (and minimum executing time) allows. */
  private gate(id: string, s: Slot): void {
    if (s.timer) return; // already waiting; it writes the latest state when it fires
    const shown = s.shown;
    const now = this.opts.scheduler.now();
    let earliest = s.lastWrite + WRITE_INTERVAL_MS;
    if (shown?.status === "executing" && this.want(id, s)?.status !== "executing") earliest = Math.max(earliest, s.executingSince + MIN_EXECUTING_MS);
    if (now >= earliest) {
      this.markDirty(id);
    } else {
      s.timer = this.opts.scheduler.timeout(() => {
        s.timer = undefined;
        this.gate(id, s); // re-checks: the state may have changed while waiting
      }, earliest - now);
    }
  }

  private queueText(id: string): void {
    this.textPending.add(id);
    if (this.textCancel) return;
    this.textCancel = this.opts.scheduler.timeout(() => {
      this.textCancel = null;
      const ids = [...this.textPending];
      this.textPending.clear();
      for (const t of ids) {
        const s = this.slots.get(t);
        if (s) this.gate(t, s);
      }
    }, TEXT_FLUSH_MS);
  }

  private markDirty(id: string): void {
    if (this.disposed) return;
    this.dirty.add(id);
    if (this.frameCancel) return;
    this.frameCancel = this.opts.scheduler.frame(() => {
      this.frameCancel = null;
      this.write();
    });
  }

  private write(): void {
    if (this.disposed) return;
    const now = this.opts.scheduler.now();
    const changed: BadgeState[] = [];
    const owed: Array<[string, Slot]> = [];
    for (const id of this.dirty) {
      const s = this.slots.get(id);
      let want = s && this.want(id, s);
      if (!s || !want) continue;
      const prev = s.shown;
      // A node that ran between two frames still shows executing first (for MIN_EXECUTING_MS).
      if (s.owesExecuting && prev?.status !== "executing" && want.status !== "executing" && want.status !== "error") {
        want = { id, kind: s.kind, status: "executing", ...(want.preview ? { preview: want.preview } : {}) };
        owed.push([id, s]);
      }
      if (want.status === "executing" || want.status === "error") s.owesExecuting = false;
      if (prev && prev.status === want.status && prev.message === want.message && prev.preview === want.preview) continue;
      if (want.status === "executing" && prev?.status !== "executing") s.executingSince = now;
      s.lastWrite = now;
      s.shown = want;
      this.textPending.delete(id);
      changed.push(want);
    }
    this.dirty.clear();
    if (changed.length) this.opts.sink(changed);
    for (const [id, s] of owed) this.gate(id, s);
  }
}

/** The real scheduler: the window's animation frames and timers. */
export function windowScheduler(win: { requestAnimationFrame?(cb: () => void): number; cancelAnimationFrame?(h: number): void } = globalThis): Scheduler {
  return {
    now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    frame: (cb) => {
      if (win.requestAnimationFrame) {
        const h = win.requestAnimationFrame(cb);
        return () => win.cancelAnimationFrame?.(h);
      }
      const t = setTimeout(cb, 16);
      return () => clearTimeout(t);
    },
    timeout: (cb, ms) => {
      const t = setTimeout(cb, ms);
      return () => clearTimeout(t);
    },
  };
}
