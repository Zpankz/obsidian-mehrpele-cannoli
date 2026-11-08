// Flow frames in Mehrpele diagrams (C4): the Run/Stop action, the context-menu items, the badge
// overlay and the footer chip, and the FlowSource a frame run hands to the runner.
//
// Everything here draws into the frame's own overlay layer `mehrpele-cannoli` and nowhere else:
                                                                                              
// visual lives in styles.css. A write to a disconnected frame, or after the host detached, is a
                         
//
// Imports no Obsidian runtime and no engine: main.ts injects the modals, notices and clipboard,
// and the runner stays a lazy chunk (type-only imports below).
import type { FrameHandle, MehrpeleApiV1 } from "mehrpele-api";
import { IdMap } from "../run/idmap";
import { type BadgeState, OverlayPersistor, type Scheduler, statusClass } from "../run/overlay-persistor";
import type { RunViewPersistor } from "../run/persistor";
import type { RunOutcome, RunRegistry, RunStatus } from "../run/registry";
import type { FlowAttachment, FlowSource } from "../run/runner";
import { formatArgsText, isFlowFrame, parseArgsText, parseFlowConfig, sourceHash } from "./fence";
import { freePath } from "./convert-note";
import { type LintIssue, lintFlow } from "./lint";
import { nodesReferencing } from "./note-refs";
import { remapId, semanticKey } from "./semantic";
import { toCannoliCanvas, type Translation } from "./translate";

export const LAYER_ID = "mehrpele-cannoli";
export const ACTION_ID = "mehrpele-cannoli:run";
export const SOURCE_CHANGED = "Flow source changed, run stopped";
export const FRAME_DESTROYED = "Flow frame destroyed, run stopped";
export const FLOW_MARKER_REMOVED = "Flow marker removed, run stopped";
export const HOST_DISABLED = "Mehrpele was disabled";
                                                                                                
export const COMPANION_DISABLED = "Mehrpele Flows was disabled";
                                                    
export const USER_STOPPED = "Stopped by user";
export const NO_HOST = "Mehrpele is not available, so Mermaid flows cannot run.";

export interface FrameRunOptions {
  isMock?: boolean;
  skipConfirm?: boolean;
  args?: Record<string, string>;
}

export type ChipStatus = "running" | RunStatus;

export interface FrameUiDeps {
  registry: RunRegistry;
  runFrame(frame: FrameHandle, opts?: FrameRunOptions): Promise<RunOutcome>;
  notice(message: string): void;
  /** The "Run with args…" modal: resolves the edited text, or null when cancelled. */
  askArgs(initial: string): Promise<string | null>;
  openLastRun(): void;
  copyText(text: string): Promise<void>;
                                                                                                  
  saveCanvas?(path: string, json: string): Promise<void>;
  exists?(path: string): boolean;
  /** A link's vault path from `sourcePath`, or null: Copy and Save write file nodes Canvas can open. */
  resolveLink?(link: string, sourcePath: string): string | null;
  scheduler: Scheduler;
}

/** Per-frame state, by frame key. */
interface FrameState {
  frame: FrameHandle;
  /** Hash of the source the badges were drawn for. */
  hash: string;
  badges: Map<string, BadgeState>;
  lint: LintIssue[];
  chip: { status: ChipStatus; startedAt: number; endedAt: number | null; tokens?: number; cost?: number } | null;
  /** The live run's persistor (until it ends). */
  persistor: OverlayPersistor | null;
  tick: (() => void) | null;
  ran: boolean;
  /** Token of the frame's latest run: a replaced run's late end must not touch the next one. */
  run: number;
                                                                                                  
  translation: Translation | null;
  idMap: IdMap | null;
}

type El = HTMLElement;

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

                                                                                                     
export function chipText(status: ChipStatus, elapsedMs: number, tokens?: number, cost?: number): string {
  return `Flow · ${status} ${mmss(elapsedMs)} · ${tokens ?? "—"} tokens · ${cost === undefined ? "—" : `~$${cost.toFixed(2)}`}`;
}

/** The hover card text for a badge (plain text, set through textContent). */
export function cardText(b: BadgeState): string {
  return [`${b.id}: ${b.status}`, b.message, b.preview].filter(Boolean).join("\n");
}

export class FrameUi {
  private api: MehrpeleApiV1 | null = null;
  private disposers: Array<() => void> = [];
  private states = new Map<string, FrameState>();
     
                                                                                                 
                                                                                                  
                                                                     
     
  private starting = new Set<string>();
     
                                                                                               
                                                                                             
                                                                                          
     
  private pendingStarts = new Map<string, { reason: string | null }>();

  constructor(private readonly deps: FrameUiDeps) {}

  get attached(): boolean {
    return this.api !== null;
  }

  /** Registers the action, menu items and frame listeners on a host api. */
  attach(api: MehrpeleApiV1): void {
    if (this.api === api) return;
    if (this.api) this.detach();
    this.api = api;
    const running = (f: FrameHandle) => this.deps.registry.has(f.key);
    this.disposers.push(
      api.addFrameAction({
        id: ACTION_ID,
        icon: (f) => (running(f) ? "square" : "play"),
        title: (f) => (running(f) ? "Stop flow" : "Run flow"),
        when: (f) => isFlowFrame(f),
        run: (f) => this.toggle(f),
      }),
      api.addMenuItems((menu, f) => {
        if (!isFlowFrame(f)) return;
        const isRunning = running(f);
        menu.addItem((i) =>
          i
            .setTitle(isRunning ? "Stop flow" : "Run flow")
            .setIcon(isRunning ? "square" : "play")
            .onClick(() => this.toggle(f)),
        );
        menu.addItem((i) =>
          i
            .setTitle("Dry run flow")
            .setIcon("flask-conical")
            .setDisabled(isRunning)
            .onClick(() => void this.start(f, { isMock: true })),
        );
        menu.addItem((i) =>
          i
            .setTitle("Run with args…")
            .setIcon("list-plus")
            .setDisabled(isRunning)
            .onClick(() => void this.runWithArgs(f)),
        );
        menu.addItem((i) =>
          i
            .setTitle("Open last run")
            .setIcon("history")
            .onClick(() => this.deps.openLastRun()),
        );
        menu.addItem((i) =>
          i
            .setTitle("Copy as Cannoli canvas")
            .setIcon("copy")
            .onClick(() => void this.copyCanvas(f)),
        );
        if (this.deps.saveCanvas)
          menu.addItem((i) =>
            i
              .setTitle("Save as .canvas")
              .setIcon("file-plus")
              .onClick(() => void this.saveCanvas(f)),
          );
      }),
      api.frames.onDidRender((f) => this.onRender(f)),
      api.frames.onDidDestroy((f) => this.onDestroy(f)),
      this.deps.registry.onChange(() => this.refreshActions()),
    );
  }

     
                                                                                               
                                                                                                   
                       
     
  detach(reason: string = HOST_DISABLED): void {
    this.api = null;
    for (const key of this.pendingStarts.keys()) this.cancelStart(key, reason);
    for (const [key, s] of this.states) {
      this.deps.registry.stop(key, reason);
      s.tick?.();
      s.persistor?.dispose();
    }
    this.states.clear();
    for (const d of this.disposers.splice(0)) {
      try {
        d();
      } catch {
        // a host that is unloading may already have dropped it
      }
    }
  }

  /** Flow frames of the active host, for the run-at-cursor command. */
  flowFrames(): FrameHandle[] {
    return this.api ? this.api.frames.list().filter((f) => isFlowFrame(f)) : [];
  }

  /** The canvas a frame translates to (throws when the host cannot translate it). */
  translate(frame: FrameHandle): Translation {
    if (!this.api) throw new Error(NO_HOST);
    return toCannoliCanvas(frame.getSource(), this.api.canvas);
  }

  /**
   * What the runner runs for a frame: translated and linted now, so a blocked flow is refused
   * before anything loads. Draws the pending chip; `attach` wires the overlay persistor.
   */
  flowSource(frame: FrameHandle, opts: FrameRunOptions = {}): FlowSource {
    const source = frame.getSource();
    const hash = sourceHash(source);
    const s = this.stateOf(frame);
    s.tick?.();
    s.persistor?.dispose();
    const token = ++s.run;
    Object.assign(s, { hash, badges: new Map(), persistor: null, tick: null, ran: true, lint: [] });
    s.chip = { status: "running", startedAt: this.deps.scheduler.now(), endedAt: null };

    let translation: Translation | null = null;
    let failure: string | null = null;
    try {
      translation = this.translate(frame);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    s.translation = translation;
    s.idMap = translation ? new IdMap(translation.canvas, frame.provenance()) : null;
    const lint = translation ? lintFlow(translation, frame.diagramType) : { blocked: false, issues: [] };
                                                                                                    
    const issues = lint.issues;
    s.lint = issues;
    this.draw(s);
    const blocked = lint.blocked ? lint.issues.find((i) => i.level === "error")?.message : undefined;
    const args = opts.args ?? translation?.config.args ?? {};
    const name = frame.sourcePath.replace(/^.*\//, "").replace(/\.md$/, "");
    return {
      key: frame.key,
      path: frame.sourcePath,
      name: `${name} flow`,
      frameKey: frame.key,
      sourceHash: hash,
      lint: issues,
      ...(blocked ? { blocked } : {}),
      args,
      read: async () => {
        if (!translation) throw new Error(`Could not translate the flow: ${failure}`);
        return structuredClone(translation.canvas);
      },
      attach: (view, redact) => this.attachRun(s, token, issues, translation!, view, redact),
    };
  }

     
                                                                                             
                                                                                                 
                                                                                            
                                                                                                 
                                                                                                 
                                                
     
  async run(
    frame: FrameHandle,
    opts: FrameRunOptions,
    io: {
      confirmReplace(key: string): Promise<boolean>;
      prepare?(): Promise<void>;
      execute(source: FlowSource): Promise<RunOutcome>;
    },
  ): Promise<RunOutcome> {
                                                                                                   
    const goneCheck = (): RunOutcome | null => {
      const gone = !this.api ? HOST_DISABLED : !frame.isConnected() ? FRAME_DESTROYED : !isFlowFrame(frame) ? FLOW_MARKER_REMOVED : null;
      if (gone) this.deps.notice(gone);
      return gone ? { status: "stopped", reason: gone } : null;
    };
    const goneBefore = goneCheck();
    if (goneBefore) return goneBefore;
    const existing = this.deps.registry.get(frame.key);
    if (existing) {
      if (!(await io.confirmReplace(frame.key))) return { status: "refused", reason: "A run of this flow is already running" };
      existing.stop();
      await existing.done.catch(() => undefined);
      const goneAfter = goneCheck();
      if (goneAfter) return goneAfter;
    }
    const source = this.flowSource(frame, opts);
    const token = this.states.get(frame.key)?.run;
    const start = { reason: null as string | null };
    this.pendingStarts.set(frame.key, start);
    let outcome: RunOutcome = { status: "error" };
    try {
      await io.prepare?.();
      if (this.pendingStarts.get(frame.key) === start) this.pendingStarts.delete(frame.key);
      if (start.reason) {
        this.deps.notice(start.reason);
        outcome = { status: "stopped", reason: start.reason };
        return outcome;
      }
      outcome = await io.execute(source);
      return outcome;
    } finally {
      if (this.pendingStarts.get(frame.key) === start) this.pendingStarts.delete(frame.key);
      this.ended(frame, outcome, token);
    }
  }

  private cancelStart(key: string, reason: string): void {
    const start = this.pendingStarts.get(key);
    if (start) start.reason ??= reason;
  }

  /**
   * The run ended (any status, including refusals before the engine started). With `token`, a run
   * that has since been replaced is ignored, so its late end cannot mark the new run's chip.
   */
  ended(frame: FrameHandle, outcome: RunOutcome, token?: number): void {
    const s = this.states.get(frame.key);
    if (!s?.chip || (token !== undefined && token !== s.run)) return;
    s.tick?.();
    s.tick = null;
    s.chip = { ...s.chip, status: outcome.status, endedAt: this.deps.scheduler.now() };
    this.draw(s);
  }

  private attachRun(s: FrameState, token: number, lint: LintIssue[], t: Translation, view: RunViewPersistor, redact: (t: string) => string): FlowAttachment {
                                                                                         
    const idMap = s.run === token && s.idMap ? s.idMap : new IdMap(t.canvas, s.frame.provenance());
    const persistor = new OverlayPersistor({
      idMap,
      scheduler: this.deps.scheduler,
      view,
      sink: (changed) => {
        if (s.persistor !== persistor) return;
        for (const b of changed) {
          const id = s.idMap ? remapId(idMap, s.idMap, b.id) : b.id;
          s.badges.set(id, id === b.id ? b : { ...b, id });
        }
        this.draw(s);
      },
    });
    persistor.setRedactor(redact);
    persistor.seed(t.canvas);
    // A run whose frame was replaced or dropped meanwhile still tees to its record, not the overlay.
    if (s.run === token) {
      s.persistor = persistor;
      this.startTick(s);
    }
    return {
      persistor: persistor.asPersistor(),
      sync: (graph) => persistor.sync(graph),
      onEvent: event => persistor.onEvent(event),
      onUsage: usage => {
        if (s.run !== token || !s.chip) return;
        s.chip = { ...s.chip, tokens: usage.inputTokens + usage.outputTokens, cost: usage.costUsd ?? undefined };
        this.drawChip(s);
      },
                                                                                   
      noteWritten: (name) => {
        if (s.run !== token || !this.api || !s.frame.isConnected()) return;
        const map = s.idMap ?? idMap;
        for (const canvasId of nodesReferencing(t.canvas, name)) {
          const m = map.resolve(canvasId);
          if (m?.kind === "node") s.frame.refreshNode(m.id);
        }
      },
      end: (status) => {
        if (status !== "complete") persistor.unfinished();
        persistor.flush();
        // Unplaced run objects: a warning in this run's record and, while it is still the frame's
        // run, in its chip (same array).
        for (const message of persistor.warnings()) lint.push({ level: "warning", code: "unplaced", message });
        if (s.run !== token) {
          persistor.dispose();
          return;
        }
        this.draw(s);
        // Owed executing flashes still play out; the next run, a stop or a detach disposes it sooner.
        persistor.settle(() => {
          if (s.persistor === persistor) s.persistor = null;
          persistor.dispose();
        });
      },
    };
  }

  private startTick(s: FrameState): void {
    const step = () => {
      if (s.chip?.status !== "running") return;
      this.drawChip(s);
      s.tick = this.deps.scheduler.timeout(step, 1000);
    };
    s.tick = this.deps.scheduler.timeout(step, 1000);
  }

  private toggle(frame: FrameHandle): void {
    if (this.deps.registry.has(frame.key)) this.deps.registry.stop(frame.key, USER_STOPPED);
    else void this.start(frame, {});
  }

                                                                              
  private async start(frame: FrameHandle, opts: FrameRunOptions): Promise<void> {
    const key = frame.key;
    if (this.starting.has(key)) return;
    this.starting.add(key);
    try {
      await this.deps.runFrame(frame, opts);
    } catch (e) {
      this.deps.notice(`Mehrpele Flows could not run this flow: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.starting.delete(key);
    }
  }

  private async runWithArgs(frame: FrameHandle): Promise<void> {
    const { config } = parseFlowConfig(frame.getSource());
    const text = await this.deps.askArgs(formatArgsText(config.args));
    if (text === null) return;
    const { args, errors } = parseArgsText(text);
    if (errors.length) {
      this.deps.notice(`Run with args: ${errors.join("; ")}`);
      return;
    }
    await this.start(frame, { args });
  }

  /**
   * The translated canvas as Copy and Save write it (raw file nodes, not engine-normalised). Each
   * file node's link text becomes the vault path it resolves to from the note (subpath kept), as
   * Obsidian's Canvas needs; a link that does not resolve stays as written.
   */
  private canvasJson(frame: FrameHandle): string {
    const t = this.translate(frame);
    const nodes = t.canvas.nodes.map((n) => {
      if (n.type !== "file" || typeof n.file !== "string" || !this.deps.resolveLink) return n;
      const path = this.deps.resolveLink(n.file, frame.sourcePath);
      return path ? { ...n, file: path } : n;
    });
    return JSON.stringify({ nodes, edges: t.canvas.edges }, null, 2);
  }

  private async copyCanvas(frame: FrameHandle): Promise<void> {
    try {
      await this.deps.copyText(this.canvasJson(frame));
      this.deps.notice("Copied the flow as a Cannoli canvas");
    } catch (e) {
      this.deps.notice(`Could not copy the flow: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

                                                                                      
  private async saveCanvas(frame: FrameHandle): Promise<void> {
    const exists = (path: string) => this.deps.exists?.(path) ?? false;
    if (!this.deps.saveCanvas) return;
    try {
      const json = this.canvasJson(frame);
      const slash = frame.sourcePath.lastIndexOf("/");
      const dir = slash >= 0 ? frame.sourcePath.slice(0, slash + 1) : "";
      const path = freePath(`${dir}${frame.sourcePath.slice(slash + 1).replace(/\.md$/, "")} flow`, ".canvas", exists);
      await this.deps.saveCanvas(path, json);
      this.deps.notice(`Saved the flow as ${path}`);
    } catch (e) {
      this.deps.notice(`Could not save the flow: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private refreshActions(): void {
    const api = this.api;
    if (!api) return;
    for (const f of api.frames.list()) if (isFlowFrame(f)) api.refreshActions(f);
  }

     
                                                                                                 
                                                                       
     
  private onRender(frame: FrameHandle): void {
    const s = this.states.get(frame.key);
    if (!isFlowFrame(frame)) {
                                                                                              
      if (s || this.pendingStarts.has(frame.key)) this.dropFlow(frame, s);
      return;
    }
    if (!s) return;
    s.frame = frame;
    const hash = sourceHash(frame.getSource());
    if (hash !== s.hash && this.keepAcrossRender(s, frame)) s.hash = hash;
    if (hash !== s.hash) {
      this.cancelStart(frame.key, SOURCE_CHANGED);
      this.deps.registry.stop(frame.key, SOURCE_CHANGED);
      s.persistor?.dispose();
      s.persistor = null;
      s.badges.clear();
      s.lint = [];
      s.hash = hash;
      if (s.chip?.status === "running") s.chip = { ...s.chip, status: "stopped", endedAt: this.deps.scheduler.now() };
    }
    this.draw(s);
  }

     
                                                                                                   
                                                                                                   
                                                                                   
     
  private keepAcrossRender(s: FrameState, frame: FrameHandle): boolean {
    const prev = s.translation;
    const from = s.idMap;
    if (!prev || !from) return false;
    let next: Translation;
    try {
      next = this.translate(frame);
    } catch {
      return false;
    }
    if (semanticKey(next) !== semanticKey(prev)) return false;
    const to = new IdMap(next.canvas, frame.provenance());
    s.badges = new Map(
      [...s.badges.values()].map((b) => {
        const id = remapId(from, to, b.id);
        return [id, id === b.id ? b : { ...b, id }];
      }),
    );
    s.translation = next;
    s.idMap = to;
    return true;
  }

  private dropFlow(frame: FrameHandle, s: FrameState | undefined): void {
    this.cancelStart(frame.key, FLOW_MARKER_REMOVED);
    this.deps.registry.stop(frame.key, FLOW_MARKER_REMOVED);
    if (!s) return;
    // Stale for the run's closures (attach, end, ended), so nothing draws through it again.
    s.run++;
    s.tick?.();
    s.tick = null;
    s.persistor?.dispose();
    Object.assign(s, { frame, persistor: null, chip: null, badges: new Map(), lint: [] });
    this.layer(s)?.replaceChildren();
    this.states.delete(frame.key);
  }

  private onDestroy(frame: FrameHandle): void {
    const s = this.states.get(frame.key);
    this.cancelStart(frame.key, FRAME_DESTROYED);
    this.deps.registry.stop(frame.key, FRAME_DESTROYED);
    if (!s) return;
    s.tick?.();
    s.persistor?.dispose();
    this.states.delete(frame.key);
  }

  private stateOf(frame: FrameHandle): FrameState {
    let s = this.states.get(frame.key);
    if (!s) {
      s = { frame, hash: "", badges: new Map(), lint: [], chip: null, persistor: null, tick: null, ran: false, run: 0, translation: null, idMap: null };
      this.states.set(frame.key, s);
    }
    s.frame = frame;
    return s;
  }

  // ---------- drawing (overlay layer only) ----------

  private layer(s: FrameState): El | null {
    if (!this.api || !s.frame.isConnected()) return null;
    try {
      return s.frame.overlay(LAYER_ID);
    } catch {
      return null;
    }
  }

  /** Redraws the frame's layer from state: badges, lint chip and run chip. */
  private draw(s: FrameState): void {
    const layer = this.layer(s);
    if (!layer) return;
    const doc = layer.ownerDocument;
    const els: El[] = [];
    for (const b of s.badges.values()) {
      if (b.kind === "edge") continue;                              
      const r = s.frame.nodeRect(b.id);
      if (!r) continue;
      const el = doc.createElement("div");
      el.className = `mpc-badge ${statusClass(b.status)} mpc-k-${b.kind}`;
      el.setAttribute("data-node-id", b.id);
      el.setCssProps({ "--mpc-x": `${r.x}px`, "--mpc-y": `${r.y}px`, "--mpc-w": `${r.width}px`, "--mpc-h": `${r.height}px` });
      const dot = doc.createElement("span");
      dot.className = "mpc-dot";
      dot.setAttribute("aria-label", cardText(b));
      const card = doc.createElement("span");
      card.className = "mpc-card";
      card.textContent = cardText(b);
      dot.appendChild(card);
      el.appendChild(dot);
      els.push(el);
    }
    const footer = doc.createElement("div");
    footer.className = "mpc-footer";
    if (s.lint.length) footer.appendChild(this.lintChip(doc, s.lint));
    if (s.chip) footer.appendChild(this.runChip(doc, s));
    if (footer.childNodes.length) els.push(footer);
    layer.replaceChildren(...els);
  }

  private drawChip(s: FrameState): void {
    const layer = this.layer(s);
    if (!layer || !s.chip) return;
    const chip = layer.querySelector(".mpc-chip");
    if (chip) chip.textContent = this.chipLabel(s);
    else this.draw(s);
  }

  private chipLabel(s: FrameState): string {
    const c = s.chip!;
    return chipText(c.status, (c.endedAt ?? this.deps.scheduler.now()) - c.startedAt, c.tokens, c.cost);
  }

  private runChip(doc: Document, s: FrameState): El {
    const chip = doc.createElement("div");
    chip.className = "mpc-chip";
    chip.setAttribute("data-run-status", s.chip!.status);
    chip.textContent = this.chipLabel(s);
    return chip;
  }

  private lintChip(doc: Document, lint: LintIssue[]): El {
    const el = doc.createElement("div");
    const blocked = lint.some((i) => i.level === "error");
    el.className = `mpc-lint${blocked ? " mpc-lint-error" : ""}`;
    const label = `${lint.length} flow warning${lint.length === 1 ? "" : "s"}`;
    el.setAttribute("aria-label", label);
    el.textContent = blocked ? "Cannot run" : label;
    const card = doc.createElement("span");
    card.className = "mpc-card";
    card.textContent = lint.map((i) => `• ${i.message}`).join("\n");
    el.appendChild(card);
    return el;
  }
}
