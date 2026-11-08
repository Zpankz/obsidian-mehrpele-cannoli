// Settings tab: what it renders per host status, and its subscription lifecycle.
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { FakeApp, FakeHost } from "mehrpele-api/testing";
import { HostConnection } from "../src/host/connect";
import { SHOW_HOST_URL } from "../src/settings/status";
import { SettingsStore } from "../src/settings/store";
import { type FakeContainerEl, fakeObsidian, obsidianLog } from "./fake-obsidian";

mock.module("obsidian", () => fakeObsidian);

let Tab: typeof import("../src/settings/tab").MehrpeleFlowsSettingTab;
beforeAll(async () => {
  Tab = (await import("../src/settings/tab")).MehrpeleFlowsSettingTab;
});

const opened: string[] = [];
const realWindow = (globalThis as Record<string, unknown>).window;
beforeEach(() => {
  obsidianLog.reset();
  opened.length = 0;
  (globalThis as Record<string, unknown>).window = { open: (url: string) => opened.push(url) };
});
afterEach(() => {
  (globalThis as Record<string, unknown>).window = realWindow;
});

function setup() {
  const app = new FakeApp();
  app.workspace.setLayoutReady();
  const conn = new HostConnection(app, { notify: () => {} });
  conn.start();
  const store = new SettingsStore({ loadData: async () => null, saveData: async () => {} });
  const tab = new Tab(app as never, {} as never, conn, store);
  return { app, conn, tab, container: (tab as unknown as { containerEl: FakeContainerEl }).containerEl };
}

/** display() renders once settings have loaded; this waits for that render. */
async function show(tab: InstanceType<typeof Tab>): Promise<void> {
  tab.display();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Every render of the host row, oldest first. */
const hostRows = () => obsidianLog.settings.filter((s) => s.name === "Mehrpele");
const last = () => hostRows().at(-1);

describe("MehrpeleFlowsSettingTab", () => {
  test("no host: Install button opens Mehrpele in the plugin browser", async () => {
    const { tab } = setup();
    await show(tab);
    expect(hostRows()).toHaveLength(1);
    expect(last()?.desc).toBe("Install Mehrpele to run flows from diagrams");
    expect(last()?.classes).toEqual(["mehrpele-flows-host-status", "mehrpele-flows-host-missing"]);
    expect(last()?.buttons.map((b) => b.text)).toEqual(["Install"]);
    last()?.buttons[0]?.click();
    expect(opened).toEqual([SHOW_HOST_URL]);
  });

  test("too-old host: Update button", async () => {
    const { app, tab } = setup();
    new FakeHost({ apiMinor: 0 }).install(app, "mehrpele", { fireReady: false });
    await show(tab);
    expect(last()?.desc).toBe("Update Mehrpele to run flows from diagrams");
    expect(last()?.classes).toContain("mehrpele-flows-host-too-old");
    expect(last()?.buttons.map((b) => b.text)).toEqual(["Update"]);
  });

  test("display re-checks the host, so a host enabled without an event shows as connected", async () => {
    const { app, tab } = setup();
    new FakeHost({ hostVersion: "1.14.0" }).install(app, "mehrpele", { fireReady: false });
    await show(tab);
    expect(last()?.desc).toBe("Connected to Mehrpele 1.14.0");
    expect(last()?.classes).toContain("mehrpele-flows-host-attached");
    expect(last()?.buttons).toEqual([]);
  });

  test("re-renders on status changes while shown, and stops after hide", async () => {
    const { app, tab, container } = setup();
    await show(tab);
    const host = new FakeHost().install(app, "mehrpele"); // fires api-ready
    expect(hostRows()).toHaveLength(2);
    expect(last()?.classes).toContain("mehrpele-flows-host-attached");
    const emptiedBeforeHide = container.emptied;
    tab.hide();
    expect(container.emptied).toBe(emptiedBeforeHide + 1);
    host.unload();
    expect(hostRows()).toHaveLength(2);
  });

  test("displaying twice keeps one subscription", async () => {
    const { app, tab } = setup();
    await show(tab);
    await show(tab);
    obsidianLog.reset();
    new FakeHost().install(app, "mehrpele");
    expect(hostRows()).toHaveLength(1);
  });
});
