                                                                                                 
// `import("./run/runner")`, so none of this is evaluated at plugin load. Everything
// Obsidian-specific comes in through RunnerDeps; what differs per flow comes in as a FlowSource.
//
//   lock (.canvas only) -> one run per key -> provider -> read flow -> probe -> confirm -> secret
//   -> Run (VaultFileManager, persistor, hostFetch) -> record (redacted) -> outcome
import type { Run as CoreRun, RunArgs, Stoppage, RunEvent, RunController } from "../flows/engine";
import { type SecretStorageLike } from "../settings/secrets";
import type { SettingsStore } from "../settings/store";
import { effectiveProvider, PROVIDER_LABELS, providerHost } from "../settings/types";
import { type ConfirmSection, confirmSections, isConfirmed, referenceSetHash } from "./confirm";
import { runSecrets } from "./secrets";
import { RunUsage, type ModelUsage } from "./events";
import { type EgressEvent, type HostFetch, textFetcher } from "./egress";
import { buildLlmConfig } from "./llm-configs";
import { cannoliIsRunning, LOCK_NOTICE, type LockApp } from "./lock";
import type { LintIssue } from "../flows/lint";
import { prepareWorkflow, restoreWorkflowData, restoreWorkflowImages, captureWorkflowData, type PreparedWorkflow, type WorkflowData } from "../flows/workflow";
import type { CanvasApiLike } from "../flows/translate";
import { RunViewPersistor } from "./persistor";
import { type AdapterLike, makeRunId, type RunRecord, writeRecord } from "./records";
import { createRedactor, type Redactor } from "./redact";
import { collectReferences } from "./references";
import type { RunHandle, RunOutcome, RunRegistry, RunStatus } from "./registry";
import { type SubpathResultLike, type VaultApp, VaultFileManager, safeVaultPath } from "./vault-file-manager";

export const NO_PROVIDER_NOTICE = "Add a model provider in Mehrpele Flows settings before running a flow.";

export interface FlowFile {
  path: string;
  basename: string;
  extension: string;
}

export interface RunOptions {
  isMock?: boolean;
  skipConfirm?: boolean;
}

/** What the runner draws into besides the run view (a frame overlay); see FlowSource.attach. */
export interface FlowAttachment {
  /** The engine's Persistor; it forwards every call to the run view. */
  persistor: object;
  /** Supplemental final reconciliation; live statuses come from the event bus. */
  sync(graph: Record<string, { status?: unknown }>): void;
  onEvent?(event: RunEvent): void;
  onUsage?(usage: ModelUsage): void;
  /** The run ended (after the last sync). */
  end(status: RunStatus): void;
                                                                                   
  noteWritten?(name: string): void;
}

                                                                        
export interface FlowSource {
  /** Registry and confirmation key: the canvas path, or the frame key `sourcePath#fenceLine`. */
  key: string;
  /** The vault file: record `flowPath`, and its folder is the flow folder. */
  path: string;
  /** Shown in notices; the core's runName. */
  name: string;
  /** The .canvas file. Only these take the Cannoli coexistence lock. */
  lockFile?: FlowFile;
  /** The flow as canvas JSON. A throw ends the run as an error record. */
  read(): Promise<unknown>;
  frameKey?: string;
  sourceHash?: string;
  /** Lint issues, kept in the record. */
  lint?: LintIssue[];
  /** Set when lint blocks the run: the refusal reason (no engine load, no prompt). */
  blocked?: string;
  /** RunArgs.args. */
  args?: Record<string, string>;
  /** Called once the run view persistor exists, with the run's redactor. */
  attach?(view: RunViewPersistor, redact: (text: string) => string): FlowAttachment;
}

export type RunnerApp = VaultApp &
  LockApp & {
    vault: VaultApp["vault"] & { adapter: AdapterLike };
    secretStorage?: SecretStorageLike;
  };

type EngineModule = Pick<typeof import("../flows/engine"), "Run" | "RunController" | "RunEventBus">;

/** A started run, as the run view and status bar see it. */
export interface ActiveRun {
  handle: RunHandle;
  flowPath: string;
  /** Set for Mermaid frame runs. */
  frameKey?: string;
  persistor: RunViewPersistor;
  isMock: boolean;
}

export interface RunnerDeps {
  app: RunnerApp;
  store: SettingsStore;
  registry: RunRegistry;
  loadEngine(): Promise<EngineModule>;
  hostFetch: HostFetch;
  /** Subscribes run `runId` to its egress decisions (see EgressDispatcher); returns an unsubscribe. */
  onEgress(runId: string, listener: (e: EgressEvent) => void): () => void;
  notice(message: string): void;
  confirm(sections: ConfirmSection[], flowPath: string): Promise<boolean>;
  confirmReplace(flowPath: string): Promise<boolean>;
  onRunStart?(run: ActiveRun): void;
  onRunEnd?(run: ActiveRun, outcome: RunOutcome): void;
  resolveSubpath?(cache: unknown, subpath: string): SubpathResultLike | null;
  canvas?: CanvasApiLike;
  workflowData?: WorkflowData;
  now?(): Date;
}

/** Starts a core Run and resolves with its first stoppage (onFinish may fire again later). */
export function startRun(
  Run: EngineModule["Run"],
  args: Omit<RunArgs, "onFinish">,
): { run: CoreRun | null; finished: Promise<Stoppage> } {
  let resolve!: (s: Stoppage) => void;
  const finished = new Promise<Stoppage>((r) => (resolve = r));
  let first: Stoppage | null = null;
  const onFinish = (s: Stoppage) => {
    if (first) return;
    first = s;
    resolve(s);
  };
  const failed = (e: unknown): Stoppage =>
    ({ reason: "error", message: e instanceof Error ? e.message : String(e) }) as Stoppage;
  let run: CoreRun;
  try {
    run = new Run({ ...args, onFinish });
  } catch (e) {
    onFinish(failed(e));
    return { run: null, finished };
  }
  if (!first) {
    run.start().catch((e: unknown) => onFinish(failed(e)));
  }
  return { run, finished };
}

/**
 * The core Run, with error messages redacted before they reach onFinish, and without the rethrow
 * in Run.error(). That throw happens after the stoppage is delivered, mostly inside an
 * EventTarget listener where nothing can catch it, so it would surface as an uncaught error that
 * carries the raw message (a provider body that quotes the key). Every caller of error() returns
 * right after it, so dropping the throw does not change control flow.
 */
export function redactingRun(Run: EngineModule["Run"], redact: (s: string) => string): EngineModule["Run"] {
  return class RedactingRun extends Run {
    error(message: string): void {
      try {
        super.error(redact(message));
      } catch {
        // already delivered through onFinish, redacted
      }
    }
  };
}

/** Own the complete execution tree; children keep their own lifecycle, not their own authority. */
function spatialRun(engine: EngineModule, workflow: PreparedWorkflow, redact: (text: string) => string) {
  const Base = redactingRun(engine.Run, redact);
  const pending = new Set<Promise<Stoppage>>();
  const subscriptions = new Set<() => void>();
  const terminals: Extract<RunEvent, { t: "run-finish" }>[] = [];
  const legacyUsage: Stoppage["usage"][] = [];
  let sequence = 0, rootCreated = false;
  let rootFinish: Extract<RunEvent, { t: "run-finish" }> | undefined;
  let sink: RunArgs["events"];
  let controller: RunArgs["controller"];
  const text = (value: string) => redact(restoreWorkflowImages(value, workflow));
  class SpatialRun extends Base {
    constructor(args: RunArgs) {
      const root = !rootCreated;
      rootCreated = true;
      if (root) { sink = args.events; controller = args.controller; }
      const prefix = root ? "" : `child-${++sequence}/`;
      const local = new engine.RunEventBus();
      const off = local.subscribe(event => {
        if (event.t === "run-finish") {
          terminals.push(event);
          if (root) rootFinish = event;
        } else if (root || ["model-request", "text-delta", "model-finish"].includes(event.t)) {
          sink?.emit("id" in event ? { ...event, id: prefix + event.id } : event);
        }
      });
      subscriptions.add(off);
      const jsonNodes = new WeakSet<object>();
      super({ ...args, events: local, onFinish: outcome => {
        legacyUsage.push(outcome.usage ?? {});
        // Preserve the root's error outcome, then stop every shared-controller child
        // before publishing that outcome or releasing the registry handle.
        if (root && outcome.reason !== "complete") controller?.stop("Workflow tree ended");
        queueMicrotask(() => { off(); subscriptions.delete(off); });
        args.onFinish?.(outcome);
      }, replacers: [async (content, _mock, node) => {
        const json = !!node && jsonNodes.has(node);
        const value = restoreWorkflowData(content, workflow, { json, protectImages: !json });
        return redact(json ? restoreWorkflowImages(value, workflow) : value);
      }, ...(args.replacers ?? [])] });
      // The engine's replacer hook does not expose cleanForJson. Carry the real
      // processReferences mode through that hook instead of guessing from node type.
      for (const object of Object.values(this.graph)) {
        const node = object as unknown as {
          processReferences?: (values?: { name: string; content: string }[], json?: boolean) => Promise<string>;
          extractImages?: (message: { content?: string | null }, index: number) => Promise<unknown[]>;
        };
        const process = node.processReferences?.bind(object);
        if (process) node.processReferences = async (values, json) => {
          if (json) jsonNodes.add(object);
          try { return await process(values, json); }
          finally { if (json) jsonNodes.delete(object); }
        };
        const extract = node.extractImages?.bind(object);
        if (extract) node.extractImages = (message, index) => args.isMock ? Promise.resolve([]) : extract({ ...message, content: message.content?.replace(/!\[.*?\]\((.*?)\)/g, (image, url: string) => {
          try { if (["http:", "https:"].includes(new URL(url).protocol)) return "[remote image reference]"; } catch { /* Preserve existing non-URL validation. */ }
          return url.startsWith("http") ? "[remote image reference]" : image;
        }) }, index);
      }
      // Prompt text is decoded only after image extraction. The request retained
      // in the graph keeps image markers for subsequent model/history boundaries.
      const request = (input: Parameters<CoreRun["callLLM"]>[0]) => ({ ...input, messages: input.messages.map(message => ({ ...message, content: text(message.content ?? "") })) });
      const call = this.callLLM.bind(this), stream = this.callLLMStream.bind(this);
      this.callLLM = (input, ...rest) => call(request(input), ...rest);
      this.callLLMStream = (input, ...rest) => stream(request(input), ...rest);
      this.subcannoliCallback = async (cannoli, inputs, isMock) => {
        if (this.controller.signal.aborted || this.stopTime !== null) throw Error("Workflow stopped");
        const safeInputs = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, captureWorkflowData(value, workflow)]));
        const origin = (cannoli as { metadata?: { workflowSource?: unknown } })?.metadata?.workflowSource;
        const scoped = args.fileManager instanceof VaultFileManager && typeof origin === "string" ? args.fileManager.forSource(origin) : args.fileManager;
        const currentNote = workflow.currentNote ?? (args.fileManager instanceof VaultFileManager && this.currentNote ? args.fileManager.resolve(this.currentNote)?.path ?? this.currentNote : this.currentNote ?? "");
        const child = startRun(SpatialRun, {
          ...args, cannoli, isMock, fileManager: scoped,
          args: { ...safeInputs, obsidianCurrentNote: currentNote, obsidianSelection: this.selection ?? "" },
          persistor: undefined,
        });
        pending.add(child.finished);
        let outcome: Stoppage;
        try { outcome = await child.finished; }
        finally { pending.delete(child.finished); }
        if (outcome.reason !== "complete") throw Error(redact(outcome.message ?? "Child workflow stopped"));
        if (this.controller.signal.aborted || this.stopTime !== null) throw Error("Workflow stopped");
        return outcome.results ?? {};
      };
    }
  }
  const join = async () => {
    while (pending.size) await Promise.all([...pending]);
    // onFinish may run inside a synchronous observer. Let the local event bus
    // drain its queued terminal events before unsubscribing or counting totals.
    await Promise.resolve();
    for (const off of subscriptions) off();
    subscriptions.clear();
  };
  return {
    Run: SpatialRun, join,
    async settle(outcome: Stoppage): Promise<Stoppage> {
      if (outcome.reason !== "complete") controller?.stop("Workflow tree ended");
      await join();
      const total: Extract<RunEvent, { t: "run-finish" }>["usage"] = { inputTokens: 0, outputTokens: 0 };
      for (const event of terminals) for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
        if (event.usage[key] !== undefined) total[key] = (total[key] ?? 0) + event.usage[key];
      }
      if (rootFinish) sink?.emit({ ...rootFinish, usage: total, costUsd: null });
      const usage: Stoppage["usage"] = {};
      for (const values of legacyUsage) for (const [model, count] of Object.entries(values)) {
        const next = usage[model] ??= { numberOfCalls: 0 };
        next.numberOfCalls += count.numberOfCalls;
        for (const key of ["promptTokens", "completionTokens"] as const) if (count[key] !== undefined) next[key] = (next[key] ?? 0) + count[key];
      }
      return { ...outcome, usage, results: Object.fromEntries(Object.entries(outcome.results ?? {}).map(([key,value]) => [key, text(value)])) };
    },
  };
}

const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs a .canvas file (C3). */
export function runCanvas(deps: RunnerDeps, file: FlowFile, opts: RunOptions = {}): Promise<RunOutcome> {
  return runFlow(
    deps,
    {
      key: file.path,
      path: file.path,
      name: file.basename,
      lockFile: file,
      read: async () => {
        try {
          return JSON.parse(await deps.app.vault.cachedRead(file)) as unknown;
        } catch (e) {
          throw new ReadError(`Could not read the canvas: ${msg(e)}`, msg(e));
        }
      },
    },
    opts,
  );
}

/** A read failure: `message` is the record reason, `detail` goes in the notice. */
export class ReadError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

/** Runs any flow source. Never rejects: every exit writes a record and resolves an outcome. */
export async function runFlow(deps: RunnerDeps, source: FlowSource, opts: RunOptions = {}): Promise<RunOutcome> {
  const { app, store, registry } = deps;
  const started = deps.now?.() ?? new Date();
  const runId = makeRunId(started);
  const flowPath = source.path;
  const key = source.key;
  const name = source.name;
  const isMock = !!opts.isMock;
  const egress: EgressEvent[] = [];
  let currentRedactor: Redactor = createRedactor([]);
  const redactor: Redactor = { text: text => currentRedactor.text(text), deep: value => currentRedactor.deep(value) };
  const usage = new RunUsage();
  let provider: string | null = null;
  let host: string | null = null;
  let confirmation: RunRecord["confirmation"] = null;
  let persistor: RunViewPersistor | null = null;
  let stoppage: Stoppage | null = null;

  const finish = async (status: RunStatus, reason?: string, message?: string): Promise<RunOutcome> => {
    const ended = deps.now?.() ?? new Date();
    const record: RunRecord = {
      version: 1,
      runId,
      flowPath,
      ...(source.frameKey ? { frameKey: source.frameKey } : {}),
      ...(source.sourceHash ? { sourceHash: source.sourceHash } : {}),
      status,
      ...(reason ? { reason } : {}),
      ...(message ? { message } : {}),
      isMock,
      provider,
      providerHost: host,
      startedAt: started.toISOString(),
      endedAt: ended.toISOString(),
      durationMs: ended.getTime() - started.getTime(),
      confirmation,
      nodes: persistor?.list() ?? [],
      egress,
      ...(source.lint?.length ? { lint: source.lint } : {}),
      ...(stoppage?.results ? { results: stoppage.results } : {}),
      ...(stoppage?.usage ? { usage: stoppage.usage } : {}),
      ...(usage.snapshot() ? { modelUsage: usage.snapshot()! } : {}),
      ...(usage.coreRunId ? { coreRunId: usage.coreRunId } : {}),
    };
    const outcome: RunOutcome = { status, ...(reason ? { reason: redactor.text(reason) } : {}) };
    try {
      const settings = await store.get();
      outcome.recordPath = await writeRecord(app.vault.adapter, redactor.deep(record), started, settings.runs.keep);
    } catch (e) {
      deps.notice(redactor.text(`Mehrpele Flows could not write the run record: ${msg(e)}`));
    }
    return outcome;
  };

  if (source.blocked) {
    deps.notice(source.blocked);
    return finish("refused", source.blocked);
  }

  // Coexistence lock: never race the Cannoli plugin on the same canvas.
  if (source.lockFile && cannoliIsRunning(app, source.lockFile)) {
    deps.notice(LOCK_NOTICE);
    return finish("refused", LOCK_NOTICE);
  }

  // One run per key: ask before stopping the current one.
  const existing = registry.get(key);
  if (existing) {
    if (!(await deps.confirmReplace(key))) return finish("refused", "A run of this flow is already running");
    existing.stop();
    await existing.done.catch(() => undefined);
    if (registry.has(key)) return finish("refused", "A run of this flow is already running");
  }

  // Claim the path now, synchronously after the check (no await in between), so a second call
  // made while this one is still confirming or loading sees it. Every exit below releases the
  // claim and settles `done`.
  let run: CoreRun | null = null;
  let controller: RunController | null = null;
  let stopRequested = false;
  let stopReason: string | undefined;
  let settle!: (o: RunOutcome) => void;
  const done = new Promise<RunOutcome>((r) => (settle = r));
  const handle: RunHandle = {
    path: key,
    runId,
    startedAt: started.getTime(),
    stop: (reason?: string) => {
      stopRequested = true;
      stopReason ??= reason;
      controller?.stop(reason);
    },
    done,
  };
  registry.add(handle);
  let active: ActiveRun | null = null;
  let outcome: RunOutcome = { status: "error" };
  try {
    outcome = await execute();
  } catch (e) {
    const cancelled = stopRequested;
    // Anything unexpected still ends as a record, never as a rejection.
    try {
      handle.stop();
    } catch {
      // the run is ending anyway
    }
    outcome = await finish(cancelled ? "stopped" : "error", cancelled ? stopReason : msg(e));
    try {
      if (!cancelled) deps.notice(`${name} failed: ${outcome.reason ?? "Unknown error"}`);
      if (active) deps.onRunEnd?.(active, outcome);
    } catch {
      // a failing listener must not turn the outcome into a rejection
    }
  } finally {
    registry.remove(key, runId);
    settle(outcome);
  }
  return outcome;

  async function execute(): Promise<RunOutcome> {
    const settings = await store.get();
    const chosen = effectiveProvider(settings);
    provider = chosen;
    host = chosen ? providerHost(settings, chosen) : null;

    let canvas: unknown;
    try {
      canvas = await source.read();
    } catch (e) {
      const read = e instanceof ReadError ? e : new ReadError(`Could not read the flow: ${msg(e)}`, msg(e));
      deps.notice(`Could not read ${name}: ${read.detail}`);
      return finish("error", read.message);
    }

    const engine = await deps.loadEngine();
    controller = new engine.RunController();
    if (stopRequested) controller.stop(stopReason);
                                                                                               
    // the real run both get this canvas.
    const prepared = await prepareWorkflow(canvas, { app, sourcePath: flowPath, currentNote: source.args?.obsidianCurrentNote, canvas: deps.canvas, data: deps.workflowData, signal: controller.signal, mock: isMock });
    const engineCanvas = prepared.root;

    // Probe: parse the flow (mock, no LLM, no IO) to list what it reads, writes and reaches. It
    // gets the run's args, so {{NOTE}} resolves to the obsidianCurrentNote the run will use.
    const args = source.args && Object.keys(source.args).length ? {
      args: Object.fromEntries(Object.entries(source.args).map(([key, value]) => [key,
        ["obsidianCurrentNote", "obsidianSelection"].includes(key) ? value : captureWorkflowData(value, prepared),
      ])),
    } : {};
    let probe: CoreRun;
    let needsModel = false;
    const hasModel = (data: CoreRun["canvasData"]) => data?.nodes.some(node => ["standard-call", "choose", "form"].includes(node.cannoliData?.type ?? "")) ?? false;
    try {
      probe = new engine.Run({ cannoli: structuredClone(engineCanvas), isMock: true, ...args });
    } catch (e) {
      deps.notice(`${name} is not a valid flow: ${msg(e)}`);
      return finish("error", msg(e));
    }
    needsModel = hasModel(probe.canvasData);
    const refs = collectReferences(probe.canvasData, host);
    for (const child of prepared.children.values()) {
      const nested = new engine.Run({ cannoli: structuredClone(child), isMock: true, args: { obsidianCurrentNote: prepared.currentNote ?? probe.currentNote ?? "", obsidianSelection: probe.selection ?? "" } });
      needsModel ||= hasModel(nested.canvasData);
      const effects = collectReferences(nested.canvasData, host);
      refs.notesRead = [...new Set([...refs.notesRead, ...effects.notesRead])].filter(name => !prepared.children.has(name)).sort();
      refs.notesWritten = [...new Set([...refs.notesWritten, ...effects.notesWritten])].sort();
      refs.httpHosts = [...new Set([...refs.httpHosts, ...effects.httpHosts])].sort();
      refs.notesCreated += effects.notesCreated;
      refs.createsOutsideFolder ||= effects.createsOutsideFolder || (effects.notesCreated > 0 && typeof child.metadata?.workflowSource === "string" && folderOf(child.metadata.workflowSource) !== folderOf(flowPath));
      refs.dynamicNotes ||= effects.dynamicNotes;
      refs.writesSelection ||= effects.writesSelection;
      refs.dynamicHttp ||= effects.dynamicHttp;
    }
    const plannedReads = await prepared.snapshotNotes(refs.notesRead.filter(name => !prepared.children.has(name)));
    const namedReads = refs.notesRead.filter(name => !prepared.children.has(name));
    const declaredPaths = new Set(namedReads.map(name => {
      const path = name.split("|")[0].split("#")[0];
      return app.metadataCache.getFirstLinkpathDest(path, flowPath)?.path;
    }));
    refs.notesRead = [...new Set([...namedReads, ...plannedReads.filter(path => !declaredPaths.has(path))])].sort();
    for (const name of [...refs.notesRead, ...refs.notesWritten]) {
      const path = name.split("|")[0].split("#")[0];
      const bindingKey = `${flowPath}\0${path}`;
      if (!prepared.bindings.has(bindingKey)) {
        const existing = app.metadataCache.getFirstLinkpathDest(path, flowPath);
        const candidate = existing?.path ?? (!path.includes("/") ? `${folderOf(flowPath) ? folderOf(flowPath) + "/" : ""}${path.replace(/\.md$/i, "")}.md` : path);
        if (candidate && path !== "No current note") prepared.bindings.set(bindingKey, safeVaultPath(candidate, app.vault.configDir));
      }
      // Predict the same canonical aliases before first creation as after it;
      // confirmation hashes must change for retargeting, not for file existence.
      const target = prepared.bindings.get(bindingKey);
      if (target) {
        prepared.bindings.set(`${flowPath}\0${target}`, target);
        if (/\.md$/i.test(target)) prepared.bindings.set(`${flowPath}\0${target.slice(0,-3)}`, target);
      }
    }
    refs.bindings = [...prepared.bindings];
    if (needsModel && !chosen) {
      deps.notice(NO_PROVIDER_NOTICE);
      return finish("refused", NO_PROVIDER_NOTICE);
    }
    let attachment: FlowAttachment | null = null;
                                                                                                    
    const fileManager = new VaultFileManager(app, {
      flowFolder: folderOf(flowPath),
      allowCreateOutsideFolder: refs.createsOutsideFolder,
      mock: isMock,
      workflowBindings: prepared.bindings,
      workflowMetadata: prepared.metadata,
      workflowSnapshots: prepared.snapshots,
      workflowProperties: prepared.properties,
      workflowBinaries: prepared.binaries,
      workflowMaxBytes: prepared.maxBytes,
      workflowText: text => redactor.text(restoreWorkflowImages(text, prepared)),
      workflowCanvases: new Map([...prepared.children].map(([key, value]) => [key, JSON.stringify(value)])),
      resolveSubpath: deps.resolveSubpath ? (file, subpath) => deps.resolveSubpath!(file, subpath) : undefined,
      sourcePath: flowPath,
      creatable: refs.notesWritten,
      onWrite: (note) => attachment?.noteWritten?.(note),
    });
    const sections = confirmSections(refs, { isMissing: (note) => fileManager.isMissingNote(note) });
    const hash = await referenceSetHash(refs);
    const alreadyConfirmed = isConfirmed(settings.confirmed, key, hash);

    if (opts.skipConfirm) {
      confirmation = { prompted: false, skipped: !alreadyConfirmed, sections };
    } else if (!alreadyConfirmed) {
      if (!(await deps.confirm(sections, key))) {
        confirmation = { prompted: true, skipped: false, sections };
        return finish("refused", "The run was not confirmed");
      }
      await store.update((s) => {
        s.confirmed[key] = hash;
      });
      confirmation = { prompted: true, skipped: false, sections };
    } else {
      confirmation = { prompted: false, skipped: false, sections };
    }

    // A stop while confirming must not read secure storage or start the engine.
    if (stopRequested) {
      deps.notice(stopReason ?? `${name} stopped`);
      return finish("stopped", stopReason);
    }
    const entry = chosen ? settings.providers[chosen] ?? {} : {};
    const secrets = runSecrets(app.secretStorage, chosen ?? "openai", isMock || !needsModel ? undefined : entry.secretId);
    currentRedactor = secrets.redactor;
    if (needsModel && !isMock && entry.secretId && !secrets.resolver.get(secrets.name)) {
      const reason = `The ${chosen ? PROVIDER_LABELS[chosen] : "model provider"} key "${entry.secretId}" is not in secure storage. Pick or add it in Mehrpele Flows settings.`;
      deps.notice(reason);
      return finish("refused", reason);
    }
    // Core still accepts provider auth via config. Its getter resolves at each call,
    // while the resolver supplies prompt/HTTP redaction and logical secret names.
    const llmConfig = chosen ? buildLlmConfig(settings, chosen, isMock ? "mock-run-sends-nothing" : secrets.apiKey) : null;

    const view = new RunViewPersistor();
    persistor = view;
    view.setRedactor(text => redactor.text(restoreWorkflowImages(text, prepared)));
    view.setLabels(prepared.labels);
    if (probe.canvasData) view.seed(probe.canvasData);
    attachment = source.attach?.(view, text => redactor.text(text)) ?? null;
    const sync = (graph: CoreRun["graph"]) => (attachment ? attachment.sync(graph) : view.sync(graph));
    const activeRun: ActiveRun = { handle, flowPath, ...(source.frameKey ? { frameKey: source.frameKey } : {}), persistor: view, isMock };
    const unsubscribe = deps.onEgress(runId, (e) => egress.push(e));
    const events = new engine.RunEventBus();
    const offEvents = events.subscribe(event => {
      const safe = redactor.deep(event);
      view.onEvent(safe);
      const totals = usage.accept(safe);
      attachment?.onEvent?.(safe);
      if (totals) attachment?.onUsage?.(totals);
    });
    const tree = spatialRun(engine, prepared, text => redactor.text(text));
    try {
      const launched = startRun(tree.Run, {
        cannoli: engineCanvas,
        isMock,
        controller, events, secrets: secrets.resolver, canvasPath: source.path,
        modelFetch: (input, init) => deps.hostFetch(input, init, runId),
        llmConfigs: llmConfig ? [llmConfig] : undefined,
        fetcher: textFetcher((input, init) => deps.hostFetch(input, init, runId)),
        fileManager,
        persistor: (attachment?.persistor ?? view) as unknown as RunArgs["persistor"],
        runName: name,
        ...args,
      });
      run = launched.run;
      active = activeRun;
      deps.onRunStart?.(activeRun);
      stoppage = await tree.settle(await launched.finished);
    } catch (error) {
      controller.stop("Workflow tree failed");
      await tree.join();
      throw error;
    } finally {
      offEvents();
      unsubscribe();
      if (run) sync(run.graph);
    }

    const status: RunStatus = stoppage.reason === "user" ? "stopped" : stoppage.reason === "error" ? "error" : "complete";
    try {
      attachment?.end(status);
    } catch {
      // the overlay must not change the outcome
    }
    const reason = status === "error" ? stoppage.message ?? "Unknown error" : status === "stopped" ? stopReason : undefined;
    const outcome = await finish(status, reason, stoppage.message);
    if (status === "error") deps.notice(`${name} failed: ${redactor.text(stoppage.message ?? "Unknown error")}`);
    else if (status === "stopped") deps.notice(stopReason ?? `${name} stopped`);
    else deps.notice(`${name} finished${isMock ? " (mock run)" : ""}`);
    deps.onRunEnd?.(activeRun, outcome);
    return outcome;
  }
}
