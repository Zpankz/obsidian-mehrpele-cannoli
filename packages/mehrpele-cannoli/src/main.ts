// Mehrpele Flows (mehrpele-cannoli): runs Cannoli-format flows from Mehrpele diagrams and canvases.
//
// onload does no work: no network, timers, file reads, engine import or console output. It
// registers the settings tab, the run view, the commands and the file-menu entry, and starts the
// host connection. Settings load on first need; the runner and the engine load on the first run
// (`import("./run/runner")`, `import("./flows/engine")`).
import { type App, type CachedMetadata, MarkdownView, Notice, Plugin, requestUrl, resolveSubpath, TFile } from "obsidian";
import type { CanvasData } from "obsidian/canvas";
import type { FrameHandle } from "mehrpele-api";
import { flowNoteBody, flowNotePath, needsMehrpele } from "./flows/convert-note";
import { nativeWorkflowData } from "./flows/native-data";
import { fenceLineAt, fenceLineOfKey } from "./flows/fence";
import { COMPANION_DISABLED, FrameUi, type FrameRunOptions, NO_HOST } from "./flows/frame-ui";
import { type AppLike, HostConnection } from "./host/connect";
import { createHostFetch, EgressDispatcher, type HostFetch, requestUrlTransport } from "./run/egress";
import { clearConsoleSecrets } from "./run/console-shim";
import { installEgress } from "./run/fetch-shim";
import { windowScheduler } from "./run/overlay-persistor";
import type { RunOutcome, RunStatus } from "./run/registry";
import { RunRegistry } from "./run/registry";
import type { ActiveRun, RunnerApp, RunnerDeps, RunOptions } from "./run/runner";
import { SettingsStore } from "./settings/store";
import { MehrpeleFlowsSettingTab } from "./settings/tab";
import { defaultSettings } from "./settings/types";
import { RunFeed } from "./view/feed";
import { askArgs, askHost, confirmFlow, confirmReplace } from "./view/modals";
import { RUN_VIEW_TYPE, RunView } from "./view/run-view";

type Engine = typeof import("./flows/engine");

export type { RunOutcome, RunStatus };

/** Obsidian's App plus the `plugins` registry it has at runtime but doesn't declare. */
type HostApp = App & Pick<AppLike, "plugins">;

export default class MehrpeleFlowsPlugin extends Plugin {
  /** Time spent inside onload, in ms, for checking load cost from the developer console. */
  loadMs = 0;
  connection: HostConnection | null = null;
                                                                                  
  frameUi: FrameUi | null = null;
  readonly registry = new RunRegistry();
  readonly feed = new RunFeed();
  store!: SettingsStore;
  private engine: Promise<Engine> | null = null;
  private hostFetch: HostFetch | null = null;
  private uninstallEgress: (() => void) | null = null;
  private readonly egressRoutes = new EgressDispatcher();
  private statusEl: HTMLElement | null = null;

  onload(): void {
    const t0 = performance.now();
    this.store = new SettingsStore(this);
    const app: AppLike = this.app as HostApp;
    this.connection = new HostConnection(app, {
      registerEvent: (ref) => this.registerEvent(ref),
      notify: (message) => new Notice(message),
    });
    this.addSettingTab(new MehrpeleFlowsSettingTab(this.app, this, this.connection, this.store));
    this.registerView(RUN_VIEW_TYPE, (leaf) => new RunView(leaf, this.feed));

    this.addCommand({
      id: "stop-all-flows",
      name: "Stop all flows",
      callback: () => {
        const n = this.registry.stopAll();
        new Notice(n ? `Stopping ${n} flow${n === 1 ? "" : "s"}` : "No flows are running");
      },
    });
    this.addCommand({
      id: "open-run-view",
      name: "Open run view",
      callback: () => void this.openRunView(),
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "canvas") return;
                                                                                           
        if (this.connection?.host)
          menu.addItem((item) =>
            item
              .setTitle("Convert to Mermaid… as flow")
              .setIcon("workflow")
              .onClick(() => void this.convertToFlow(file)),
          );
      }),
    );
    this.addCommand({
      id: "run-flow-at-cursor",
      name: "Run flow at cursor",
      checkCallback: (checking) => {
        const frame = this.frameAtCursor();
        if (!frame) return false;
        if (!checking) void this.runFrameFromUi(frame);
        return true;
      },
    });
    this.register(this.registry.onChange(() => this.updateStatusBar()));
                                                                                       
    this.register(this.connection.onChange(() => this.syncFrameUi()));

    this.connection.start();
    this.loadMs = performance.now() - t0;
  }

  onunload(): void {
    // Each stopped run still writes its record (status "stopped") through the vault adapter. Frame
                                                                                    
    this.frameUi?.detach(COMPANION_DISABLED);
    this.frameUi = null;
    this.registry.stopAll();
    this.uninstallEgress?.();
    this.uninstallEgress = null;
    clearConsoleSecrets();
    this.connection?.dispose();
    this.connection = null;
    this.engine = null;
  }

  /**
   * The Cannoli engine, evaluated on first call only. A failed evaluation is not retried:
   * esbuild's lazy init keeps the error and rethrows it, so the rejection is cached too.
   */
  loadEngine(): Promise<Engine> {
    this.engine ??= import("./flows/engine");
    return this.engine;
  }

  /**
   * Runs a canvas outside Cannoli. Resolves when the run has finished and its record is written.
   * Never writes the .canvas.
   */
  async runCanvas(file: TFile, opts: RunOptions = {}): Promise<RunOutcome> {
    await this.store.get();
    const runner = await import("./run/runner");
    let started = false;
    const deps = this.runnerDeps(() => (started = true));
    const outcome = await runner.runCanvas(deps, file, opts);
    if (!started) this.feed.ended(file.path, outcome, null);
    return outcome;
  }

  /**
   * Runs a diagram workflow frame (`pele workflow`, with legacy fence compatibility). Resolves when the run has finished and
   * its record is written. Never writes the note.
   */
  async runFrame(frame: FrameHandle, opts: FrameRunOptions = {}): Promise<RunOutcome> {
    const ui = this.frameUi;
    if (!ui?.attached) {
      new Notice(NO_HOST);
      return { status: "refused", reason: NO_HOST };
    }
    let runner: typeof import("./run/runner") | null = null;
    return ui.run(frame, opts, {
      confirmReplace: (key) => confirmReplace(this.app, key),
                                                                                    
      prepare: async () => {
        await this.store.get();
        runner = await import("./run/runner");
      },
      // No await before runFlow: it claims the registry at once.
      execute: async (source) => {
        runner ??= await import("./run/runner");
        let started = false;
        const outcome = await runner.runFlow(this.runnerDeps(() => (started = true)), source, opts);
        if (!started) this.feed.ended(source.path, outcome, null);
        return outcome;
      },
    });
  }

  private runnerDeps(onStarted: () => void): RunnerDeps {
    return {
      app: this.app,
      canvas: this.connection?.host?.canvas,
      workflowData: nativeWorkflowData(this.app),
      store: this.store,
      registry: this.registry,
      loadEngine: () => this.loadEngine(),
      hostFetch: this.egress(),
      onEgress: (runId, listener) => this.egressRoutes.subscribe(runId, listener),
      notice: (message) => new Notice(message),
      confirm: (sections, flowPath) => confirmFlow(this.app, flowPath, sections),
      confirmReplace: (flowPath) => confirmReplace(this.app, flowPath),
      onRunStart: (active: ActiveRun) => {
        onStarted();
        this.feed.started(active);
      },
      onRunEnd: (active, outcome) => this.feed.ended(active.flowPath, outcome, active),
      resolveSubpath: (cache, subpath) => resolveSubpath(cache as CachedMetadata, subpath),
    };
  }

  private syncFrameUi(): void {
    const host = this.connection?.host ?? null;
    if (!host) {
      this.frameUi?.detach();
      return;
    }
    this.frameUi ??= new FrameUi({
      registry: this.registry,
      runFrame: (frame, opts) => this.runFrame(frame, opts),
      notice: (message) => new Notice(message),
      askArgs: (initial) => askArgs(this.app, initial),
      openLastRun: () => void this.openRunView(),
      copyText: (text) => navigator.clipboard.writeText(text),
                                                                              
      saveCanvas: async (path, json) => void (await this.app.vault.create(path, json)),
      exists: (path) => this.app.vault.getAbstractFileByPath(path) !== null,
      resolveLink: (link, sourcePath) => this.app.metadataCache.getFirstLinkpathDest(link, sourcePath)?.path ?? null,
      scheduler: windowScheduler(window),
    });
    this.frameUi.attach(host);
  }

     
                                                                                  
                                                                    
     
  private async convertToFlow(file: TFile): Promise<void> {
    const host = this.connection?.host;
    if (!host) {
      new Notice(NO_HOST);
      return;
    }
    try {
      const canvas = JSON.parse(await this.app.vault.cachedRead(file)) as CanvasData;
      const lang = needsMehrpele(canvas) ? "mehrpele" : "mermaid";
      const source = host.canvas.canvasToMermaid(canvas, { mehrpele: lang === "mehrpele" });
      const path = flowNotePath(file.path, (p) => this.app.vault.getAbstractFileByPath(p) !== null);
      const note = await this.app.vault.create(path, flowNoteBody(file.path, source, lang));
      await this.app.workspace.getLeaf(false).openFile(note);
    } catch (e) {
      new Notice(`Could not convert ${file.basename}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Live Preview / source: the flow fence holding the cursor. Reading view: the first flow frame. */
  private frameAtCursor(): FrameHandle | null {
    const frames = this.frameUi?.flowFrames() ?? [];
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!frames.length || !view?.file) return null;
    const path = view.file.path;
    const mine = frames.filter((f) => f.sourcePath === path);
    if (view.getMode() === "source") {
      const editor = view.editor;
      const line = fenceLineAt(editor.getValue().split("\n"), editor.getCursor().line);
      return line === null ? null : (mine.find((f) => fenceLineOfKey(f.key) === line) ?? null);
    }
    return mine.sort((a, b) => (fenceLineOfKey(a.key) ?? 0) - (fenceLineOfKey(b.key) ?? 0))[0] ?? null;
  }

  private async runFrameFromUi(frame: FrameHandle): Promise<void> {
    try {
      await this.runFrame(frame);
    } catch (e) {
      new Notice(`Mehrpele Flows could not run this flow: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async openRunView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(RUN_VIEW_TYPE)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return;
      await right.setViewState({ type: RUN_VIEW_TYPE, active: true });
      leaf = right;
    }
    await workspace.revealLeaf(leaf);
  }

  /** hostFetch, created and installed as the bundle's fetch on the first run. */
  private egress(): HostFetch {
    if (!this.hostFetch) {
      this.hostFetch = createHostFetch({
        getSettings: () => this.store.current ?? defaultSettings(),
        transport: requestUrlTransport(requestUrl),
        askHost: (host) => askHost(this.app, host),
        onApprove: async (host) => {
          await this.store.update((s) => {
            if (!s.network.approvedHosts.includes(host)) s.network.approvedHosts.push(host);
          });
        },
        onRequest: (event) => this.egressRoutes.dispatch(event),
      });
    }
    this.uninstallEgress ??= installEgress(this.hostFetch);
    return this.hostFetch;
  }

  private updateStatusBar(): void {
    const n = this.registry.size;
    if (!n) {
      this.statusEl?.remove();
      this.statusEl = null;
      return;
    }
    if (!this.statusEl) {
      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass("mehrpele-flows-status", "mod-clickable");
      this.statusEl.addEventListener("click", () => void this.openRunView());
    }
    this.statusEl.setText(n === 1 ? "1 flow running" : `${n} flows running`);
  }
}
