// Finds the Mehrpele host plugin and keeps Mehrpele Flows registered with it (README: Host
// connection).
//
// No runtime import of "obsidian" here, so the tests run against mehrpele-api's FakeApp.

import type { EventRef } from "obsidian";
import type {
  CompanionFeatureDef,
  Disposer,
  MehrpeleApiMinorFrames,
  MehrpeleApiReadyEvent,
  MehrpeleApiUnloadEvent,
  MehrpeleApiV1,
  MehrpeleHostId,
  MehrpeleHostPlugin,
} from "mehrpele-api";
import manifest from "../../manifest.json";

/**
 * Host plugin ids in lookup order. `pele-mermaid` is the pre-rename dev id; it stays while
 * mehrpele-api's `MehrpeleHostId` still lists it.
 */
export const HOST_IDS: readonly MehrpeleHostId[] = ["mehrpele", "pele-mermaid"];

export const API_READY_EVENT: MehrpeleApiReadyEvent = "mehrpele:api-ready";
export const API_UNLOAD_EVENT: MehrpeleApiUnloadEvent = "mehrpele:api-unload";

/** The lowest host `apiMinor` Mehrpele Flows needs (frames, actions, menus). */
export const REQUIRED_MINOR = 1 satisfies MehrpeleApiMinorFrames;

export const FEATURE_ID = "mehrpele-cannoli";

const FEATURE: CompanionFeatureDef = {
  id: FEATURE_ID,
  name: "Mehrpele Flows",
  version: manifest.version,
  requiredHostMinor: REQUIRED_MINOR,
};

export const TOO_OLD_MESSAGE = `Mehrpele 1.${REQUIRED_MINOR}+ API needed for diagram flows`;

/**
 * The part of `App` this module touches. mehrpele-api's FakeApp fits as is; Obsidian's App
 * fits once its undeclared (private API) `plugins` member is added, which main.ts does.
 */
export interface AppLike {
  workspace: {
    on(name: string, callback: (...data: unknown[]) => unknown, ctx?: unknown): EventRef;
    offref(ref: EventRef): void;
    onLayoutReady(callback: () => unknown): void;
  };
  plugins: { plugins: Record<string, unknown> };
}

export type FoundHost = { id: MehrpeleHostId; api: MehrpeleApiV1 } | { id: MehrpeleHostId; tooOld: true };

/**
 * `too-old` covers every host plugin that is loaded but unusable: an `apiMinor` below
 * `REQUIRED_MINOR`, a missing member, an unknown major with no `apiV1`, or a host whose
 * `registerFeature` throws. The fix in each case is a newer Mehrpele.
 */
export type HostStatus = "attached" | "too-old" | "missing";

const isFn = (v: unknown): boolean => typeof v === "function";

/**
 * True when `api` is a V1 surface at `REQUIRED_MINOR` or later with the members Mehrpele Flows
 * calls (registration now; frame actions and menus once flows run from diagrams). Other V1
 * members are trusted from `apiVersion` and `apiMinor`.
 */
function isCompatible(api: unknown): api is MehrpeleApiV1 {
  if (!api || typeof api !== "object") return false;
  const a = api as NonNullable<MehrpeleHostPlugin["api"]>;
  if (a.apiVersion !== 1) return false;
  if ((a.apiMinor ?? 0) < REQUIRED_MINOR) return false;
  return (
    isFn(a.registerFeature) &&
    isFn(a.addFrameAction) &&
    isFn(a.addMenuItems) &&
    !!a.frames &&
    typeof a.frames.list === "function" &&
    typeof a.frames.onDidRender === "function" &&
    typeof a.frames.onDidDestroy === "function"
  );
}

/**
 * The first compatible host in `HOST_IDS` order (`api`, else `apiV1`). A host plugin that is
 * present but offers neither counts as too old. Null when no host plugin is loaded.
 */
export function findHost(app: AppLike): FoundHost | null {
  let tooOld: FoundHost | null = null;
  for (const id of HOST_IDS) {
    const plugin = app.plugins.plugins[id] as MehrpeleHostPlugin | undefined;
    if (!plugin) continue;
    if (isCompatible(plugin.api)) return { id, api: plugin.api };
    if (isCompatible(plugin.apiV1)) return { id, api: plugin.apiV1 };
    tooOld ??= { id, tooOld: true };
  }
  return tooOld;
}

export interface HostConnectionOptions {
  /** The plugin's `registerEvent`, so Obsidian also drops the listeners on unload. */
  registerEvent?: (ref: EventRef) => void;
  /** Shows the "too old" message; main.ts passes `new Notice(…)`. */
  notify: (message: string) => void;
}

/** The host Mehrpele Flows is registered with, and how to unregister. */
interface Attachment {
  api: MehrpeleApiV1;
  unregister: Disposer;
}

/** Tracks the host: attaches on `mehrpele:api-ready`, detaches on `mehrpele:api-unload`. */
export class HostConnection {
  private attachment: Attachment | null = null;
  private refs: EventRef[] = [];
  private listeners = new Set<(status: HostStatus) => void>();
  private statusValue: HostStatus = "missing";
  private layoutReady = false;
  private noticeShown = false;
  private started = false;
  private disposed = false;

  constructor(
    private app: AppLike,
    private opts: HostConnectionOptions,
  ) {}

  get status(): HostStatus {
    return this.statusValue;
  }

  get hostVersion(): string | null {
    return this.attachment?.api.hostVersion ?? null;
  }

  /** The attached host API, or null. */
  get host(): MehrpeleApiV1 | null {
    return this.attachment?.api ?? null;
  }

  /**
   * Subscribes to status changes, and to swaps from one attached host to another (status stays
   * `attached`, but `host` and `hostVersion` change). Returns an unsubscribe function.
   */
  onChange(cb: (status: HostStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const ws = this.app.workspace;
    this.listen(ws.on(API_READY_EVENT, () => this.refresh()));
    this.listen(ws.on(API_UNLOAD_EVENT, () => this.onUnloadHint()));
    ws.onLayoutReady(() => {
      if (this.disposed) return;
      this.layoutReady = true;
      this.refresh();
    });
    this.refresh();
  }

  /** Looks for the host again and attaches, or records why it can't. */
  refresh(): void {
    if (this.disposed) return;
    const found = findHost(this.app);
    if (found && "api" in found && this.attach(found.api)) return;
    const status = found ? "too-old" : "missing";
    this.detach(status);
    if (status === "too-old" && this.layoutReady && !this.noticeShown) {
      this.noticeShown = true;
      this.opts.notify(TOO_OLD_MESSAGE);
    }
  }

  /**
   * Registers with `api`, replacing any earlier host. False when the host's `registerFeature`
   * throws: refresh() then treats the host as too old, because onload must not throw.
   */
  private attach(api: MehrpeleApiV1): boolean {
    if (this.attachment?.api === api) return true;
    this.release();
    let unregister: Disposer;
    try {
      unregister = api.registerFeature(FEATURE);
    } catch {
      return false;
    }
    this.attachment = { api, unregister };
    this.emit("attached");
    return true;
  }

  /**
   * `mehrpele:api-unload` is a hint any plugin can trigger. Detach only when the attached
   * api says it is no longer live, or it is no longer the one the host plugin exposes.
   */
  private onUnloadHint(): void {
    const api = this.attachment?.api;
    if (!api) return;
    const live = typeof api.isLive === "function" ? api.isLive() : undefined;
    const found = findHost(this.app);
    const current = found && "api" in found ? found.api : null;
    if (live === false || current !== api) this.detach();
  }

  /** Drops the host registration (once), forgets the host and reports `status`. */
  detach(status: Exclude<HostStatus, "attached"> = "missing"): void {
    this.release();
    if (this.statusValue !== status) this.emit(status);
  }

  /**
   * Unregisters from the host and removes every workspace listener this connection added.
   * Subscribers are dropped first and not notified, so no subscriber code runs during unload.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    for (const ref of this.refs.splice(0)) this.app.workspace.offref(ref);
    this.release();
    this.statusValue = "missing";
  }

  /** Unregisters from the current host without reporting a status. */
  private release(): void {
    const attachment = this.attachment;
    this.attachment = null;
    try {
      attachment?.unregister();
    } catch {
      // A host bug must not stop the detach (or onunload) halfway, as in attach().
    }
  }

  private listen(ref: EventRef): void {
    this.refs.push(ref);
    this.opts.registerEvent?.(ref);
  }

  /** Records `status` and tells every subscriber, even when only the host changed. */
  private emit(status: HostStatus): void {
    this.statusValue = status;
    for (const cb of [...this.listeners]) cb(status);
  }
}
