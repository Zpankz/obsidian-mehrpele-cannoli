// Test helper: run a canvas against a fake vault and wait for the stoppage,
// giving up after a timeout so a hung run fails the test instead of blocking it.
// Mock mode (the default) skips the vault for reference nodes; pass
// isMock: false to exercise it. Canvases without LLM calls need no network.
import type { FileManager } from "../../src/fileManager";
import type { Reference } from "../../src/graph";
import { Run, type RunArgs, type Stoppage } from "../../src/run";

export interface FakeVault {
  fileManager: FileManager;
  /** Every FileManager call, in order. */
  log: string[];
}

/** A FileManager that serves mock note text. Override getNote to change it. */
export function fakeVault(
  getNote?: (reference: Reference) => Promise<string | null>,
): FakeVault {
  const log: string[] = [];
  const fileManager: FileManager = {
    async editNote(reference) {
      log.push(`editNote ${reference.name}`);
    },
    async getNote(reference) {
      log.push(`getNote ${reference.name}`);
      return getNote
        ? getNote(reference)
        : `# ${reference.name}\nMock note body.`;
    },
    async getFile() {
      return null;
    },
    async getCanvas() {
      return null;
    },
    editSelection() {},
    async getPropertyOfNote() {
      return null;
    },
    async getAllPropertiesOfNote() {
      return null;
    },
    async editPropertyOfNote() {},
    async createNoteAtExistingPath(noteName) {
      return noteName;
    },
    async createNoteAtNewPath(noteName) {
      return noteName;
    },
    async getNotePath(noteName) {
      return `${noteName}.md`;
    },
    async createFolder() {
      return true;
    },
    async moveNote() {
      return true;
    },
  };
  return { fileManager, log };
}

export interface RunCanvasResult {
  run: Run;
  /** Every stoppage reported, in order. A healthy run reports exactly one. */
  stoppages: Stoppage[];
  /** False when no stoppage arrived before the timeout (the run hung). */
  finished: boolean;
}

export interface RunCanvasOptions {
  vault?: FakeVault;
  /** Defaults to true. */
  isMock?: boolean;
  timeoutMs?: number;
  /** Extra Run constructor arguments (config, seed, llmConfigs, ...). */
  runArgs?: Partial<RunArgs>;
  /** Called after the Run is built and before start(), e.g. to swap its LLM. */
  beforeStart?: (run: Run) => void | Promise<void>;
  /** Called after start() and before waiting, e.g. to stop the run. */
  afterStart?: (run: Run) => void | Promise<void>;
}

export async function runCanvas(
  canvas: unknown,
  opts: RunCanvasOptions = {},
): Promise<RunCanvasResult> {
  const stoppages: Stoppage[] = [];
  let resolveFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => (resolveFirst = resolve));

  const run = new Run({
    cannoli: structuredClone(canvas),
    isMock: opts.isMock ?? true,
    fileManager: (opts.vault ?? fakeVault()).fileManager,
    fetcher: async () => {
      throw new Error("network disabled in tests");
    },
    ...opts.runArgs,
    onFinish: (stoppage) => {
      stoppages.push(stoppage);
      resolveFirst();
    },
  });

  await opts.beforeStart?.(run);
  await run.start();
  await opts.afterStart?.(run);

  const finished = await Promise.race([
    first.then(() => true),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), opts.timeoutMs ?? 2000),
    ),
  ]);
  // Let stray work settle so a second, late stoppage would be seen.
  await new Promise((resolve) => setTimeout(resolve, 50));

  return { run, stoppages, finished };
}
