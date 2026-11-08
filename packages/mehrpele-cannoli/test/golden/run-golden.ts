// The golden run path, shared by the canvas goldens (golden.test.ts) and the Mermaid goldens
// (mermaid-golden.test.ts). The run path is the BUILT bundle (stubs plus the fetch and console
// injects): runCanvas with skipConfirm over a fake app, so the probe, the RunViewPersistor, the
// redacting Run and the real VaultFileManager all take part. The engine handed to the runner
// records each run and wraps its file manager in a logging proxy that writes the contract's
// vaultLog lines. Notes the flows reference exist in the fake vault with the contract body
// `# ${name}\nMock note body.`. Math.random = 0, no network.
import { expect } from "bun:test";
import type { Bundled } from "../support/bundled";
import { fakeApp, fileOf } from "../support/fake-app";
import { openaiSettings, runnerHarness } from "../support/runner";
import { NOTES } from "./golden-flows";
import { normalize } from "./normalize";

const TIMEOUT_MS = 10_000;

/** The contract's log line for each FileManager call: "<method> <first identifying arg>". */
const LOG_ARG: Record<string, (a: any[]) => string> = {
  editNote: (a) => a[0].name,
  getNote: (a) => a[0].name,
  editSelection: (a) => String(a[0].length),
  getPropertyOfNote: (a) => `${a[0]} ${a[1]}`,
  editPropertyOfNote: (a) => `${a[0]} ${a[1]}`,
  createNoteAtNewPath: (a) => `${a[1]}/${a[0]}`,
  moveNote: (a) => `${a[0]} ${a[1]}`,
};

function logging<T extends object>(target: T, log: string[]): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const v = Reflect.get(t, prop, receiver);
      if (typeof prop !== "string" || typeof v !== "function") return v;
      return (...args: any[]) => {
        log.push(`${prop} ${(LOG_ARG[prop] ?? ((a) => String(a[0])))(args)}`);
        return v.apply(t, args);
      };
    },
  });
}

export async function runGolden(B: Bundled, slug: string, canvasText: string) {
  const flowPath = `Flows/${slug}.canvas`;
  const fake = fakeApp({
    [flowPath]: canvasText,
    ...Object.fromEntries(NOTES.map((n) => [`${n}.md`, `# ${n.split("/").pop()}\nMock note body.`])),
  });
  const network: string[] = [];
  const vaultLog: string[] = [];
  const runs: { run: any; stoppages: unknown[]; fileManager: unknown }[] = [];
  class GoldenRun extends B.Run {
    constructor(args: any) {
      const seen = { run: null as any, stoppages: [] as unknown[], fileManager: args.fileManager };
      const onFinish = args.onFinish;
      super({
        ...args,
        // Hold choices stable across the original and translated canvas ids.
        seed: 0,
        ...(args.fileManager ? { fileManager: logging(args.fileManager, vaultLog) } : {}),
        onFinish: (s: unknown) => {
          seen.stoppages.push(s);
          onFinish?.(s);
        },
      });
      seen.run = this;
      if (args.fileManager) runs.push(seen); // the probe has no file manager
    }
  }
  const refuse = async (input: unknown): Promise<Response> => {
    network.push(String(input));
    throw new Error("network disabled in golden run");
  };
  const h = runnerHarness(fake, openaiSettings(), {
    loadEngine: async () => ({ Run: GoldenRun as unknown as typeof B.Run, RunController: B.RunController, RunEventBus: B.RunEventBus }),
    hostFetch: refuse,
  });
  const realRandom = Math.random;
  const off = B.installEgress(refuse);
  Math.random = () => 0;
  try {
    const outcome = await Promise.race([
      B.runCanvas(h.deps, fileOf(flowPath), { isMock: true, skipConfirm: true }),
      new Promise<null>((r) => setTimeout(() => r(null), TIMEOUT_MS)),
    ]);
    await new Promise((r) => setTimeout(r, 50)); // a late second stoppage would show up here
    expect(runs).toHaveLength(1);
    const [{ run, stoppages, fileManager }] = runs;
    expect(fileManager).toBeInstanceOf(B.VaultFileManager);
    expect(stoppages).toHaveLength(1);
    return {
      normalised: normalize(stoppages[0] as never, run, vaultLog),
      network,
      outcome,
      // Mock runs never touch notes: the only vault IO is the canvas read and the run record.
      io: fake.calls.filter((c) => !c.startsWith(`cachedRead ${flowPath}`) && !c.startsWith("adapter.")),
    };
  } finally {
    Math.random = realRandom;
    off();
  }
}
