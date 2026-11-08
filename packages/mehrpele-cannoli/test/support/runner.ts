// RunnerDeps over the fake app, with prompts and notices recorded. The engine is the real one
// (src/flows/engine, imported by Bun straight from TypeScript).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfirmSection } from "../../src/run/confirm";
import { EgressDispatcher, type HostFetch } from "../../src/run/egress";
import { RunRegistry } from "../../src/run/registry";
import type { RunnerApp, RunnerDeps } from "../../src/run/runner";
import { SettingsStore } from "../../src/settings/store";
import { type FakeApp, fakeSettingsHost } from "./fake-app";

export const FIXTURES = join(import.meta.dir, "..", "..", "..", "cannoli-core", "test", "fixtures", "college");
export const fixture = (rel: string): string => readFileSync(join(FIXTURES, rel), "utf8");
export const HELLO = "1. Basics/1. Hello world.canvas";

/** Fake, low-entropy key used wherever a configured provider needs a secret id to point at. */
export const FAKE_KEY = "fake-key-for-tests-aaaa";

export const openaiSettings = (extra: Record<string, unknown> = {}) => ({
  providers: { openai: { secretId: "mehrpele-flows-key-openai" } },
  defaultProvider: "openai",
  ...extra,
});

/** A hostFetch that refuses everything (unit tests never reach the network). */
export const refuseAll: HostFetch = async (input) => {
  throw new Error(`Host not allowed: ${String(input)}`);
};

export function runnerHarness(fake: FakeApp, settings: unknown, over: Partial<RunnerDeps> = {}) {
  const host = fakeSettingsHost(settings);
  const store = new SettingsStore(host);
  const registry = new RunRegistry();
  const notices: string[] = [];
  const prompts: { sections: ConfirmSection[]; flowPath: string }[] = [];
  const replaceAsks: string[] = [];
  const egress = new EgressDispatcher();
  let engineLoads = 0;
  const ctl = {
    host,
    store,
    registry,
    notices,
    prompts,
    replaceAsks,
    egress,
    confirmAnswer: true,
    replaceAnswer: true,
    get engineLoads() {
      return engineLoads;
    },
    deps: null as unknown as RunnerDeps,
  };
  ctl.deps = {
    app: fake.app as unknown as RunnerApp,
    store,
    registry,
    loadEngine: () => {
      engineLoads++;
      return import("../../src/flows/engine");
    },
    hostFetch: refuseAll,
    onEgress: (runId, l) => egress.subscribe(runId, l),
    notice: (m) => notices.push(m),
    confirm: async (sections, flowPath) => {
      prompts.push({ sections, flowPath });
      return ctl.confirmAnswer;
    },
    confirmReplace: async (flowPath) => {
      replaceAsks.push(flowPath);
      return ctl.replaceAnswer;
    },
    ...over,
  };
  return ctl;
}

/** The run records written so far, parsed, in write order (the fake keeps insertion order). */
export function records(fake: FakeApp): any[] {
  return [...fake.files.entries()].filter(([p]) => p.startsWith(".mehrpele-cannoli/runs/")).map(([, v]) => JSON.parse(v));
}
