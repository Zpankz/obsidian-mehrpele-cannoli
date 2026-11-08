import { describe, expect, test } from "bun:test";
import type { EventRef, Workspace } from "obsidian";
import type {
  CompanionFeatureDef,
  FrameActionDef,
  FrameHandle,
  MehrpeleApiEvent,
  MehrpeleApiV1,
  MehrpeleApiV1Core,
  MehrpeleHostPlugin,
} from "../src/index";
import { FakeApp, FakeHost } from "../src/testing";

// Type-level conformance: FakeHost is a full MehrpeleApiV1, and a host plugin entry
// accepts it. These fail at `tsc --noEmit` if the contract and the fake drift apart.
const asV1: MehrpeleApiV1 = new FakeHost();
asV1 satisfies MehrpeleApiV1Core;
({ api: asV1 }) satisfies MehrpeleHostPlugin;
const readyName: MehrpeleApiEvent = "mehrpele:api-ready";

// Within major 1 no member is ever removed. Pin the exact member sets so removing or
// renaming one fails `tsc`; adding one means updating these lists on purpose.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
true satisfies Equals<
  keyof MehrpeleApiV1,
  | "apiVersion"
  | "apiMinor"
  | "hostVersion"
  | "pele"
  | "registerFeature"
  | "frames"
  | "addFrameAction"
  | "refreshActions"
  | "addMenuItems"
  | "canvas"
  | "mountCanvas"
  | "isLive"
>;
true satisfies Equals<keyof MehrpeleApiV1["frames"], "list" | "forElement" | "onDidRender" | "onDidDestroy">;
true satisfies Equals<keyof MehrpeleApiV1["canvas"], "mermaidToCanvas" | "canvasToMermaid">;
true satisfies Equals<
  keyof FrameHandle,
  | "key"
  | "sourcePath"
  | "lang"
  | "fenceRest"
  | "diagramType"
  | "getSource"
  | "provenance"
  | "nodeRect"
  | "overlay"
  | "refreshNode"
  | "isConnected"
>;
true satisfies Equals<keyof CompanionFeatureDef, "id" | "name" | "version" | "requiredHostMinor" | "dispose">;
true satisfies Equals<keyof FrameActionDef, "id" | "icon" | "title" | "when" | "run">;

// A plugin entry from another major is still describable, so companions can reject it.
({ api: { apiVersion: 2 } }) satisfies MehrpeleHostPlugin;

// The Workspace.on overloads accept both api events (type-level only; never called).
((ws: Workspace) => [
  ws.on("mehrpele:api-ready", () => {}),
  ws.on("mehrpele:api-unload", () => {}),
]) satisfies (ws: Workspace) => EventRef[];

test("the contract module has no runtime exports", async () => {
  expect(Object.keys(await import("../src/index"))).toEqual([]);
});

describe("FakeHost", () => {
  test("reports version 1 and the requested minor", () => {
    const host = new FakeHost({ apiMinor: 3, hostVersion: "9.9.9" });
    expect(host.apiVersion).toBe(1);
    expect(host.apiMinor).toBe(3);
    expect(host.hostVersion).toBe("9.9.9");
    expect(new FakeHost().apiMinor).toBe(1);
  });

  test("install exposes the api at once but fires api-ready only after layout ready", () => {
    const app = new FakeApp();
    const seen: string[] = [];
    app.workspace.on(readyName, () => seen.push("ready"));
    const host = new FakeHost().install(app, "pele-mermaid");
    expect(app.plugins.plugins["pele-mermaid"]?.api).toBe(host);
    expect(app.plugins.enabledPlugins.has("pele-mermaid")).toBe(true);
    expect(seen).toEqual([]);
    app.workspace.setLayoutReady();
    expect(seen).toEqual(["ready"]);
  });

  test("a host enabled after layout ready fires api-ready immediately", () => {
    const app = new FakeApp();
    app.workspace.setLayoutReady();
    let fired = 0;
    app.workspace.on("mehrpele:api-ready", () => fired++);
    new FakeHost().install(app);
    expect(fired).toBe(1);
  });

  test("a host unloaded before layout ready never fires api-ready", () => {
    const app = new FakeApp();
    let fired = 0;
    app.workspace.on("mehrpele:api-ready", () => fired++);
    new FakeHost().install(app).unload();
    app.workspace.setLayoutReady();
    expect(fired).toBe(0);
  });

  test("unload then reinstall before layout ready fires api-ready once", () => {
    const app = new FakeApp();
    let fired = 0;
    app.workspace.on("mehrpele:api-ready", (api) => {
      expect((api as MehrpeleApiV1).isLive?.()).toBe(true);
      fired++;
    });
    const host = new FakeHost().install(app);
    host.unload();
    expect(host.isLive()).toBe(false);
    host.install(app);
    expect(host.isLive()).toBe(true);
    app.workspace.setLayoutReady();
    expect(fired).toBe(1);
  });

  test("install can skip the ready event", () => {
    const app = new FakeApp();
    app.workspace.setLayoutReady();
    let fired = 0;
    app.workspace.on("mehrpele:api-ready", () => fired++);
    new FakeHost().install(app, "mehrpele", { fireReady: false });
    expect(fired).toBe(0);
  });

  test("a feature disposer called after host unload does not dispose twice", () => {
    const host = new FakeHost().install(new FakeApp());
    let disposed = 0;
    const off = host.registerFeature({
      id: "c",
      name: "C",
      version: "0.1.0",
      requiredHostMinor: 1,
      dispose: () => disposed++,
    });
    host.unload();
    off();
    expect(disposed).toBe(1);
  });

  test("disposing a feature removes its overlay layers and keeps other layers", () => {
    const host = new FakeHost();
    const frame = host.addFrame();
    const off = host.registerFeature({ id: "c", name: "C", version: "0.1.0", requiredHostMinor: 1 });
    const own = frame.overlay("c");
    const sub = frame.overlay("c:badges");
    const other = frame.overlay("cx");
    off();
    expect(frame.layerIds()).toEqual(["cx"]);
    for (const [layer, connected] of [
      [own, false],
      [sub, false],
      [other, true],
    ] as const) {
      expect((layer as unknown as { isConnected: boolean }).isConnected).toBe(connected);
    }
  });

  test("re-registering a feature id replaces the earlier registration", () => {
    const host = new FakeHost();
    const frame = host.addFrame();
    const disposed: string[] = [];
    const base = { id: "c", name: "C", version: "0.1.0", requiredHostMinor: 1 };
    const offFirst = host.registerFeature({ ...base, dispose: () => disposed.push("first") });
    host.registerFeature({ ...base, dispose: () => disposed.push("second") });
    expect(disposed).toEqual(["first"]);
    frame.overlay("c");
    offFirst();
    expect(frame.layerIds()).toEqual(["c"]);
    host.unload();
    expect(disposed).toEqual(["first", "second"]);
  });

  test("forElement finds the frame that owns an element, null otherwise", () => {
    const host = new FakeHost();
    const child = {} as HTMLElement;
    const root = { contains: (el: unknown) => el === child } as unknown as HTMLElement;
    const frame = host.addFrame({ elements: [root] });
    expect(host.frames.forElement(root)).toBe(frame);
    expect(host.frames.forElement(child)).toBe(frame);
    expect(host.frames.forElement({} as HTMLElement)).toBeNull();
    host.destroy(frame);
    expect(host.frames.forElement(root)).toBeNull();
  });

  test("per-frame icon and title resolve per frame; refreshActions is recorded", () => {
    const host = new FakeHost();
    const running = new Set<string>();
    host.addFrameAction({
      id: "run",
      icon: (f) => (running.has(f.key) ? "square" : "play"),
      title: (f) => (running.has(f.key) ? "Stop" : "Run flow"),
      when: () => true,
      run: () => {},
    });
    const frame = host.addFrame();
    expect(host.buttonsFor(frame)).toEqual([{ id: "run", icon: "play", title: "Run flow" }]);
    running.add(frame.key);
    host.refreshActions(frame);
    expect(frame.actionRefreshes).toBe(1);
    expect(host.buttonsFor(frame)).toEqual([{ id: "run", icon: "square", title: "Stop" }]);
  });

  test("unload fires api-unload before disposing features and frames", () => {
    const app = new FakeApp();
    const host = new FakeHost().install(app);
    const order: string[] = [];
    const frame = host.addFrame();
    host.registerFeature({
      id: "c",
      name: "C",
      version: "0.1.0",
      requiredHostMinor: 1,
      dispose: () => order.push(`dispose:${frame.isConnected()}`),
    });
    host.frames.onDidDestroy(() => order.push("destroy"));
    host.frames.onDidRender(() => order.push("render"));
    host.addFrameAction({ id: "a", icon: "play", title: "A", when: () => true, run: () => {} });
    host.addMenuItems(() => {});
    app.workspace.on("mehrpele:api-unload", () => order.push(`unload:${frame.isConnected()}`));
    host.unload();
    expect(order).toEqual(["unload:true", "dispose:true", "destroy"]);
    expect(app.plugins.plugins.mehrpele).toBeUndefined();
    expect(host.registrations()).toEqual({ features: 0, actions: 0, menus: 0, renderCbs: 0, destroyCbs: 0 });
  });

  test("isLive is true until unload and already false when api-unload fires with the api", () => {
    const app = new FakeApp();
    const host = new FakeHost().install(app);
    const seen: Array<{ live: boolean; arg: unknown }> = [];
    app.workspace.on("mehrpele:api-unload", (arg) => seen.push({ live: host.isLive(), arg }));
    expect(host.isLive()).toBe(true);
    host.unload();
    expect(seen).toEqual([{ live: false, arg: host }]);
    expect(host.isLive()).toBe(false);
  });

  test("api-ready passes the api as the argument", () => {
    const app = new FakeApp();
    const args: unknown[] = [];
    app.workspace.on("mehrpele:api-ready", (arg) => args.push(arg));
    const host = new FakeHost().install(app);
    app.workspace.setLayoutReady();
    expect(args).toEqual([host]);
  });

  test("registerFeature disposer removes the feature once and calls dispose once", () => {
    const host = new FakeHost();
    let disposed = 0;
    const off = host.registerFeature({
      id: "c",
      name: "C",
      version: "0.1.0",
      requiredHostMinor: 1,
      dispose: () => disposed++,
    });
    expect(host.features.has("c")).toBe(true);
    off();
    off();
    expect(host.features.has("c")).toBe(false);
    expect(disposed).toBe(1);
  });

  test("onDidRender fires on first render and every re-render with the same handle", () => {
    const host = new FakeHost();
    const keys: string[] = [];
    const off = host.frames.onDidRender((f) => keys.push(f.key));
    const frame = host.addFrame({ sourcePath: "A.md", fenceLine: 4 });
    host.render(frame, "flowchart TD\n x");
    expect(keys).toEqual(["A.md#4", "A.md#4"]);
    expect(frame.getSource()).toBe("flowchart TD\n x");
    off();
    host.render(frame);
    expect(keys.length).toBe(2);
  });

  test("overlay layers persist across re-renders and are removed on destroy", () => {
    const host = new FakeHost();
    const frame = host.addFrame();
    const layer = frame.overlay("flows");
    host.render(frame);
    expect(frame.overlay("flows")).toBe(layer);
    expect(frame.layerIds()).toEqual(["flows"]);
    host.destroy(frame);
    expect(frame.isConnected()).toBe(false);
    expect((layer as unknown as { isConnected: boolean }).isConnected).toBe(false);
    expect(host.frames.list()).toEqual([]);
  });

  test("custom layer factory is used", () => {
    const made: string[] = [];
    const host = new FakeHost({
      createLayer: (id) => {
        made.push(id);
        return { id } as unknown as HTMLElement;
      },
    });
    host.addFrame().overlay("x");
    expect(made).toEqual(["x"]);
  });

  test("nodeRect returns DOMRect-shaped boxes, null for unknown or destroyed", () => {
    const host = new FakeHost();
    const frame = host.addFrame({ rects: { a: { x: 10, y: 20, width: 30, height: 40 } } });
    const r = frame.nodeRect("a");
    expect(r).toMatchObject({ x: 10, y: 20, width: 30, height: 40, right: 40, bottom: 60 });
    expect(frame.nodeRect("b")).toBeNull();
    host.destroy(frame);
    expect(frame.nodeRect("a")).toBeNull();
  });

  test("frame actions are filtered by when() and removed by their disposer", () => {
    const host = new FakeHost();
    const off = host.addFrameAction({
      id: "run",
      icon: "play",
      title: "Run",
      when: (f) => f.fenceRest.includes("cannoli"),
      run: () => {},
    });
    const plain = host.addFrame();
    const flow = host.addFrame({ fenceRest: "cannoli", fenceLine: 9 });
    expect(host.actionsFor(plain)).toEqual([]);
    expect(host.actionsFor(flow).map((a) => a.id)).toEqual(["run"]);
    off();
    expect(host.actionsFor(flow)).toEqual([]);
  });

  test("menu callbacks add items when a frame menu opens", () => {
    const host = new FakeHost();
    const frame = host.addFrame();
    let clicked = false;
    const off = host.addMenuItems((menu, f) => {
      menu.addItem((item) =>
        item
          .setTitle(`Run ${f.key}`)
          .setIcon("play")
          .onClick(() => {
            clicked = true;
          }),
      );
    });
    const menu = host.openMenu(frame);
    expect(menu.titles()).toEqual([`Run ${frame.key}`]);
    menu.items[0]?.handler?.({} as MouseEvent);
    expect(clicked).toBe(true);
    off();
    expect(host.openMenu(frame).items).toEqual([]);
  });

  test("canvas conversion and mountCanvas have working defaults", () => {
    const host = new FakeHost();
    expect(host.canvas.mermaidToCanvas("flowchart LR").canvas).toEqual({ nodes: [], edges: [] });
    expect(host.canvas.canvasToMermaid({ nodes: [], edges: [] })).toBe("flowchart LR");
    const m = host.mountCanvas({ path: "a.canvas" } as never, {} as HTMLElement);
    m.destroy();
    expect(host.mounts[0]?.destroyed).toBe(true);
  });
});

describe("FakeWorkspace", () => {
  test("offref removes a listener", () => {
    const app = new FakeApp();
    let n = 0;
    const ref = app.workspace.on("x", () => n++);
    app.workspace.trigger("x");
    app.workspace.offref(ref);
    app.workspace.trigger("x");
    expect(n).toBe(1);
    expect(app.workspace.listenerCount()).toBe(0);
  });

  test("onLayoutReady queues until layout is ready, then runs immediately", () => {
    const app = new FakeApp();
    const order: string[] = [];
    app.workspace.onLayoutReady(() => order.push("early"));
    expect(order).toEqual([]);
    app.workspace.setLayoutReady();
    app.workspace.onLayoutReady(() => order.push("late"));
    expect(order).toEqual(["early", "late"]);
  });
});
