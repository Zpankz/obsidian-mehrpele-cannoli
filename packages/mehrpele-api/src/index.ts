// The contract between the Mehrpele host plugin and its companion plugins.
//
// Types only: this module has no runtime code, so importing it never pulls host or
// companion code into the other's bundle. A version mismatch shows up as a type error
// at build time rather than a crash at runtime.
//
// Versioning:
// - `apiVersion` is the major version. A breaking change bumps it; within major 1 no
//   member is ever removed.
// - `apiMinor` counts additive changes. A companion checks `apiMinor >= N` and then
//   feature-detects optional members (`typeof api.member === "function"`).

import type { EventRef, Menu, TFile } from "obsidian";
import type { CanvasData } from "obsidian/canvas";

// Typed workspace events, so companions can call `app.workspace.on("mehrpele:api-ready", …)`
// without a cast. Type-level only. The host passes its api as the argument, but any plugin
// can trigger a workspace event, so the argument is `unknown`: treat it as a hint only.
declare module "obsidian" {
  interface Workspace {
    on(name: MehrpeleApiReadyEvent, callback: (api?: unknown) => unknown, ctx?: unknown): EventRef;
    on(name: MehrpeleApiUnloadEvent, callback: (api?: unknown) => unknown, ctx?: unknown): EventRef;
  }
}

/** Removes a registration. Calling it more than once is a no-op. */
export type Disposer = () => void;

/** Plugin ids that may expose the host API, in lookup order. `pele-mermaid` is the earlier id. */
export type MehrpeleHostId = "mehrpele" | "pele-mermaid";

/**
 * Fired on `app.workspace` by the host from `onLayoutReady`, and again whenever it is
 * enabled, with the api as the argument. A hint only: see `MehrpeleApiV1.isLive`.
 */
export type MehrpeleApiReadyEvent = "mehrpele:api-ready";

/**
 * Fired on `app.workspace` by the host on unload, after `isLive()` turns false and before
 * it disposes companion features and frames, with the api as the argument. A hint only:
 * see `MehrpeleApiV1.isLive`.
 */
export type MehrpeleApiUnloadEvent = "mehrpele:api-unload";

export type MehrpeleApiEvent = MehrpeleApiReadyEvent | MehrpeleApiUnloadEvent;

/** The current major version. */
export type MehrpeleApiMajor = 1;

/** The minor version that added frames, actions, menus, canvas conversion and `mountCanvas`. */
export type MehrpeleApiMinorFrames = 1;

/**
 * The host's Pele runtime, passed through so companions never bundle a second copy.
 * Opaque here: companions that need it narrow it to the members they use.
 */
export type PeleRuntime = Readonly<Record<string, unknown>>;

/** What a companion registers with the host so the host can list it and dispose it. */
export interface CompanionFeatureDef {
  /** The companion's plugin id, e.g. `mehrpele-cannoli`. */
  id: string;
  /** Display name, e.g. "Mehrpele Flows". */
  name: string;
  /** The companion's manifest version. */
  version: string;
  /** The lowest `apiMinor` the companion needs. The host shows "Update needed" below it. */
  requiredHostMinor: number;
  /** Called by the host when it disposes the feature (host unload or the returned disposer). */
  dispose?(): void;
}

/** The fence languages a diagram frame can come from. */
export type FrameLang = "mermaid" | "pele" | "mehrpele";

/** `%% pele-canvas %%` provenance: diagram node id → original canvas id. */
export interface FrameProvenance {
  nodes: Record<string, { canvasId: string }>;
}

/** A rendered diagram frame. The same handle survives re-renders of the same fence. */
export interface FrameHandle {
  /** `sourcePath#fenceLine`, stable across re-renders. */
  readonly key: string;
  readonly sourcePath: string;
  readonly lang: FrameLang;
  /** Extra tokens after the fence language, e.g. "cannoli". */
  readonly fenceRest: string;
  /** Mermaid diagram type, e.g. "flowchart". */
  readonly diagramType: string;
  /** The current fence body. */
  getSource(): string;
  provenance(): FrameProvenance | null;
  /**
   * A node's box in overlay-layer coordinates, measured in the active frame (see
   * `overlay`); null if the node is not rendered, its box is 0×0, or that frame is hidden.
   */
  nodeRect(id: string): DOMRect | null;
  /**
   * A host-owned layer above the rendered diagram, created on first use and kept across
   * re-renders. The caller owns its children; the host never writes into it.
   *
   * Use the companion's feature id as the layer id, or `<featureId>:<name>`. When that
   * feature is disposed, the host removes those layers from every frame.
   *
   * One fence can have several frames at once (the Reading view and Live Preview of one
   * tab, or the note open in two tabs). The layer lives in the active one: the frame that
   * last rendered or last became visible. It moves there (same element) and `onDidRender`
   * fires for the handle. Limit: with two frames of one key visible at once, the layer
   * shows only in the active one.
   */
  overlay(layerId: string): HTMLElement;
  /** Re-renders one node card (e.g. after its note changed). */
  refreshNode(id: string): void;
  /** False once the frame has been destroyed. */
  isConnected(): boolean;
}

/** A static value, or one computed per frame (e.g. "Run" vs "Stop" while a flow runs). */
export type PerFrame<T> = T | ((frame: FrameHandle) => T);

/**
 * A button added to every frame's action bar for which `when` returns true. The host
 * evaluates `when`, `icon` and `title` on each render and on `refreshActions(frame)`.
 */
export interface FrameActionDef {
  /** Unique per companion, e.g. `mehrpele-cannoli:run`. */
  id: string;
  /** Lucide icon id. */
  icon: PerFrame<string>;
  title: PerFrame<string>;
  when(frame: FrameHandle): boolean;
  run(frame: FrameHandle, evt: MouseEvent): void;
}

export interface MermaidToCanvasResult {
  canvas: CanvasData;
  fidelity: unknown;
  dropped: unknown[];
}

/** apiMinor 0: the base handshake. A missing `apiMinor` means 0. */
export interface MehrpeleApiV1Core {
  readonly apiVersion: MehrpeleApiMajor;
  readonly apiMinor?: number;
  readonly hostVersion: string;
  readonly pele: PeleRuntime;
  /** The disposer also removes the feature's overlay layers (see `FrameHandle.overlay`). */
  registerFeature(def: CompanionFeatureDef): Disposer;
}

/** apiMinor 1: everything a companion needs to work on rendered diagrams. */
export interface MehrpeleApiV1 extends MehrpeleApiV1Core {
  /** At least `MehrpeleApiMinorFrames`; later minors only add optional members. */
  readonly apiMinor: number;
  frames: {
    list(): FrameHandle[];
    forElement(el: HTMLElement): FrameHandle | null;
    /**
     * Called after every render, including the first, and whenever node boxes move without
     * a render: the active frame changes or shows again, or its diagram scrolls (below the
     * minimum scale it scrolls sideways; at most once per animation frame). Re-place overlay
     * children from `nodeRect`.
     */
    onDidRender(cb: (frame: FrameHandle) => void): Disposer;
    onDidDestroy(cb: (frame: FrameHandle) => void): Disposer;
  };
  addFrameAction(def: FrameActionDef): Disposer;
  /** Re-evaluates `when`, `icon` and `title` of every action on one frame. */
  refreshActions(frame: FrameHandle): void;
  /** Called each time a frame's context menu opens, after the built-in items. */
  addMenuItems(cb: (menu: Menu, frame: FrameHandle) => void): Disposer;
  canvas: {
    mermaidToCanvas(src: string, opts?: object): MermaidToCanvasResult;
    canvasToMermaid(canvas: CanvasData, opts?: object): string;
  };
  /** Renders a `.canvas` file as a diagram frame inside `el`. */
  mountCanvas(file: TFile, el: HTMLElement, opts?: { fenceRest?: string }): { destroy(): void };
  /**
   * True until the host starts unloading. The api events are hints: any plugin can
   * trigger them. Trust only `app.plugins.plugins[id].api` and `isLive()`: on
   * `mehrpele:api-unload`, detach only if the attached api's `isLive()` returns false or
   * it is no longer the plugin's `api`.
   */
  isLive?(): boolean;
}

/**
 * What a host plugin instance looks like from `app.plugins.plugins[id]`, before the
 * companion has checked it. `apiVersion` is a plain number here so a companion can test
 * for other majors. After a major bump, the host keeps the v1 surface under `apiV1` for
 * a release.
 */
export interface MehrpeleHostPlugin {
  api?: { apiVersion?: number; apiMinor?: number } & Partial<
    Omit<MehrpeleApiV1, "apiVersion" | "apiMinor">
  >;
  apiV1?: MehrpeleApiV1;
}
