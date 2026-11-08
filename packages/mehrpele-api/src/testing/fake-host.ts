// Test helper: an in-memory host that implements MehrpeleApiV1. Companions test against
// it (with FakeApp), so they never wait for the real host API to land. Not for runtime use.

import type { Menu, TFile } from "obsidian";
import type { CanvasData } from "obsidian/canvas";
import type {
  CompanionFeatureDef,
  Disposer,
  FrameActionDef,
  FrameHandle,
  MehrpeleApiReadyEvent,
  MehrpeleApiUnloadEvent,
  MehrpeleApiV1,
  MehrpeleHostId,
  MermaidToCanvasResult,
  PeleRuntime,
  PerFrame,
} from "../index";
import type { FakeApp } from "./fake-app";
import { fakeElement } from "./fake-element";
import { FakeFrame, type FakeFrameInit } from "./fake-frame";
import { FakeMenu } from "./fake-menu";

const READY: MehrpeleApiReadyEvent = "mehrpele:api-ready";
const UNLOAD: MehrpeleApiUnloadEvent = "mehrpele:api-unload";

/** A disposer that runs `fn` once, however often it is called. */
function once(fn: () => void): Disposer {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

export interface FakeHostOptions {
  apiMinor?: number;
  hostVersion?: string;
  pele?: PeleRuntime;
  /** Creates overlay layers. Defaults to a plain-object fake element. */
  createLayer?: (layerId: string) => HTMLElement;
  mermaidToCanvas?: (src: string, opts?: object) => MermaidToCanvasResult;
  canvasToMermaid?: (canvas: CanvasData, opts?: object) => string;
}

export class FakeHost implements MehrpeleApiV1 {
  readonly apiVersion = 1 as const;
  readonly apiMinor: number;
  readonly hostVersion: string;
  readonly pele: PeleRuntime;

  readonly features = new Map<string, CompanionFeatureDef>();
  private featureDisposers = new Map<string, Disposer>();
  readonly actions = new Map<string, FrameActionDef>();
  readonly menuCallbacks = new Set<(menu: Menu, frame: FrameHandle) => void>();
  readonly mounts: Array<{ file: TFile; el: HTMLElement; opts?: { fenceRest?: string }; destroyed: boolean }> = [];

  private frameList: FakeFrame[] = [];
  private renderCbs = new Set<(f: FrameHandle) => void>();
  private destroyCbs = new Set<(f: FrameHandle) => void>();
  private createLayer: (layerId: string) => HTMLElement;
  private installedIn: { app: FakeApp; id: string } | null = null;
  private live = true;

  constructor(private opts: FakeHostOptions = {}) {
    this.apiMinor = opts.apiMinor ?? 1;
    this.hostVersion = opts.hostVersion ?? "1.13.1";
    this.pele = opts.pele ?? Object.freeze({});
    this.createLayer =
      opts.createLayer ?? ((layerId) => fakeElement(layerId) as unknown as HTMLElement);
  }

  // ----- MehrpeleApiV1 -----

  registerFeature(def: CompanionFeatureDef): Disposer {
    // Re-registering an id replaces the earlier registration (disposing it first).
    this.featureDisposers.get(def.id)?.();
    const dispose = once(() => {
      if (this.features.get(def.id) === def) {
        this.features.delete(def.id);
        this.featureDisposers.delete(def.id);
      }
      for (const frame of this.frameList) frame.removeLayers(def.id);
      def.dispose?.();
    });
    this.features.set(def.id, def);
    this.featureDisposers.set(def.id, dispose);
    return dispose;
  }

  frames = {
    list: (): FrameHandle[] => this.frameList.filter((f) => f.isConnected()),
    forElement: (el: HTMLElement): FrameHandle | null =>
      this.frameList.find(
        (f) =>
          f.isConnected() &&
          f.elements.some((root) => root === el || (typeof root.contains === "function" && root.contains(el))),
      ) ?? null,
    onDidRender: (cb: (f: FrameHandle) => void): Disposer => {
      this.renderCbs.add(cb);
      return once(() => this.renderCbs.delete(cb));
    },
    onDidDestroy: (cb: (f: FrameHandle) => void): Disposer => {
      this.destroyCbs.add(cb);
      return once(() => this.destroyCbs.delete(cb));
    },
  };

  addFrameAction(def: FrameActionDef): Disposer {
    this.actions.set(def.id, def);
    return once(() => {
      if (this.actions.get(def.id) === def) this.actions.delete(def.id);
    });
  }

  refreshActions(frame: FrameHandle): void {
    if (frame instanceof FakeFrame) frame.actionRefreshes++;
  }

  addMenuItems(cb: (menu: Menu, frame: FrameHandle) => void): Disposer {
    this.menuCallbacks.add(cb);
    return once(() => this.menuCallbacks.delete(cb));
  }

  canvas = {
    mermaidToCanvas: (src: string, opts?: object): MermaidToCanvasResult =>
      this.opts.mermaidToCanvas?.(src, opts) ?? {
        canvas: { nodes: [], edges: [] },
        fidelity: null,
        dropped: [],
      },
    canvasToMermaid: (canvas: CanvasData, opts?: object): string =>
      this.opts.canvasToMermaid?.(canvas, opts) ?? "flowchart LR",
  };

  isLive(): boolean {
    return this.live;
  }

  mountCanvas(file: TFile, el: HTMLElement, opts?: { fenceRest?: string }): { destroy(): void } {
    const mount = { file, el, opts, destroyed: false };
    this.mounts.push(mount);
    return {
      destroy: once(() => {
        mount.destroyed = true;
      }),
    };
  }

  // ----- test controls -----

  /** Adds a frame and renders it once. */
  addFrame(init: FakeFrameInit = {}): FakeFrame {
    const frame = new FakeFrame(init, this.createLayer);
    this.frameList.push(frame);
    this.render(frame);
    return frame;
  }

  /** Re-renders a frame: same handle, same overlay layers, render callbacks fire. */
  render(frame: FakeFrame, source?: string): void {
    if (source !== undefined) frame.source = source;
    frame.renders++;
    for (const cb of [...this.renderCbs]) cb(frame);
  }

  destroy(frame: FakeFrame): void {
    frame.markDestroyed();
    this.frameList = this.frameList.filter((f) => f !== frame);
    for (const cb of [...this.destroyCbs]) cb(frame);
  }

  /** The action-bar buttons a frame would show, in registration order. */
  actionsFor(frame: FrameHandle): FrameActionDef[] {
    return [...this.actions.values()].filter((a) => a.when(frame));
  }

  /** The buttons as drawn: per-frame `icon` and `title` resolved. */
  buttonsFor(frame: FrameHandle): Array<{ id: string; icon: string; title: string }> {
    const resolve = (v: PerFrame<string>) => (typeof v === "function" ? v(frame) : v);
    return this.actionsFor(frame).map((a) => ({ id: a.id, icon: resolve(a.icon), title: resolve(a.title) }));
  }

  /** Opens the frame's context menu and returns the companion-added items. */
  openMenu(frame: FrameHandle): FakeMenu {
    const menu = new FakeMenu();
    for (const cb of [...this.menuCallbacks]) cb(menu as unknown as Menu, frame);
    return menu;
  }

  /** Number of live registrations of each kind, for leak checks. */
  registrations(): { features: number; actions: number; menus: number; renderCbs: number; destroyCbs: number } {
    return {
      features: this.features.size,
      actions: this.actions.size,
      menus: this.menuCallbacks.size,
      renderCbs: this.renderCbs.size,
      destroyCbs: this.destroyCbs.size,
    };
  }

  /**
   * Installs the host into a FakeApp under `id` and fires `mehrpele:api-ready` once the
   * layout is ready, as the real host does (immediately if the layout is already ready,
   * i.e. the host was enabled later).
   */
  install(app: FakeApp, id: MehrpeleHostId = "mehrpele", { fireReady = true } = {}): this {
    const installed = { app, id };
    this.live = true;
    this.installedIn = installed;
    app.plugins.plugins[id] = { api: this };
    app.plugins.manifests[id] = { id, version: this.hostVersion };
    app.plugins.enabledPlugins.add(id);
    if (fireReady) {
      app.workspace.onLayoutReady(() => {
        // Only the install that queued this may fire: an unload and reinstall before
        // layout ready must not fire twice.
        if (this.installedIn === installed) app.workspace.trigger(READY, this);
      });
    }
    return this;
  }

  /**
   * Unloads the host the way the real one does: `isLive()` turns false, then
   * `mehrpele:api-unload` fires with the api, then features and frames are disposed, then
   * every remaining registration is dropped and the plugin is removed. Each feature is
   * disposed through its registration disposer, so a later call to that disposer is a no-op.
   */
  unload(): void {
    this.live = false;
    const installed = this.installedIn;
    if (installed) installed.app.workspace.trigger(UNLOAD, this);
    for (const dispose of [...this.featureDisposers.values()]) dispose();
    for (const frame of [...this.frameList]) this.destroy(frame);
    this.actions.clear();
    this.menuCallbacks.clear();
    this.renderCbs.clear();
    this.destroyCbs.clear();
    if (installed) {
      delete installed.app.plugins.plugins[installed.id];
      installed.app.plugins.enabledPlugins.delete(installed.id);
    }
    this.installedIn = null;
  }
}
