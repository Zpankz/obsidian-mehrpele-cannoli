// Plugin wiring: onload/onunload and the lazy engine, against fake "obsidian" and engine modules.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { FakeApp, FakeHost } from "mehrpele-api/testing";
import { ENGINE_MARKER } from "../src/flows/engine";
import { TOO_OLD_MESSAGE } from "../src/host/connect";
import { fakeObsidian, obsidianLog } from "./fake-obsidian";

// Only "obsidian" is replaced: the engine is real, because a mocked module stays mocked for the
// whole test process. That onload leaves the engine unevaluated is checked on the bundle (lazy
// init_engine in bundle.test.ts).
mock.module("obsidian", () => fakeObsidian);

type Mod = typeof import("../src/main");
type FakePlugin = InstanceType<Mod["default"]> & {
  events: unknown[];
  tabs: unknown[];
  views: string[];
  commands: string[];
  unload(): void;
};
let M: Mod;
let Tab: typeof import("../src/settings/tab").MehrpeleFlowsSettingTab;
let RUN_VIEW_TYPE: string;

// The frame UI schedules overlay writes on `window`, which bun lacks.
const realWindow = (globalThis as Record<string, unknown>).window;
beforeAll(async () => {
  (globalThis as Record<string, unknown>).window = globalThis;
  M = await import("../src/main");
  Tab = (await import("../src/settings/tab")).MehrpeleFlowsSettingTab;
  RUN_VIEW_TYPE = (await import("../src/view/run-view")).RUN_VIEW_TYPE;
});

afterAll(() => {
  (globalThis as Record<string, unknown>).window = realWindow;
});

beforeEach(() => {
  obsidianLog.reset();
});

function setup({ layoutReady = true } = {}) {
  const app = new FakeApp();
  if (layoutReady) app.workspace.setLayoutReady();
  const P = M.default as unknown as new (app: unknown, manifest: unknown) => FakePlugin;
  return { app, plugin: new P(app, {}) };
}

describe("onload", () => {
  test("adds the settings tab, run view and commands, and starts the connection", () => {
    const { app, plugin } = setup();
    const host = new FakeHost({ hostVersion: "1.14.0" }).install(app, "mehrpele", { fireReady: false });
    plugin.onload();
    expect(plugin.tabs).toHaveLength(1);
    expect(plugin.tabs[0]).toBeInstanceOf(Tab);
    expect(plugin.views).toEqual([RUN_VIEW_TYPE]);
    expect(plugin.commands.sort()).toEqual(["open-run-view", "run-flow-at-cursor", "stop-all-flows"]);
    expect(plugin.connection?.status).toBe("attached");
    expect(plugin.connection?.host).toBe(host);
    expect(host.features.has("mehrpele-cannoli")).toBe(true);
    expect(plugin.events).toHaveLength(3); // api-ready, api-unload and file-menu, via registerEvent
    expect(obsidianLog.notices).toEqual([]);
    expect(plugin.loadMs).toBeGreaterThanOrEqual(0);
  });

  test("a too-old host gets an Obsidian notice", () => {
    const { app, plugin } = setup();
    new FakeHost({ apiMinor: 0 }).install(app, "mehrpele", { fireReady: false });
    plugin.onload();
    expect(plugin.connection?.status).toBe("too-old");
    expect(obsidianLog.notices).toEqual([TOO_OLD_MESSAGE]);
  });
});

describe("unload", () => {
  test("unregisters from the host and drops every listener", () => {
    const { app, plugin } = setup();
    const host = new FakeHost().install(app, "mehrpele", { fireReady: false });
    plugin.onload();
    plugin.unload();
    expect(plugin.connection).toBeNull();
    expect(host.features.size).toBe(0);
    expect(app.workspace.listenerCount()).toBe(0);
  });
});

describe("loadEngine", () => {
  test("evaluates the engine once", async () => {
    const { plugin } = setup();
    plugin.onload();
    const first = plugin.loadEngine();
    expect(plugin.loadEngine()).toBe(first);
    expect((await first).ENGINE_MARKER).toBe(ENGINE_MARKER);
  });
});
