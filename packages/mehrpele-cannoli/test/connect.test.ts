import { describe, expect, test } from "bun:test";
import type { EventRef } from "obsidian";
import type { CompanionFeatureDef, Disposer } from "mehrpele-api";
import { FakeApp, FakeHost } from "mehrpele-api/testing";
import manifest from "../manifest.json";
import {
  API_READY_EVENT as READY,
  API_UNLOAD_EVENT as UNLOAD,
  findHost,
  HostConnection,
  TOO_OLD_MESSAGE,
} from "../src/host/connect";
import { statusText } from "../src/settings/status";

/** Wraps `dispose` so each call is counted in `count.disposed`. */
function countedDisposer(dispose: Disposer, count: { disposed: number }): Disposer {
  return () => {
    count.disposed++;
    dispose();
  };
}

/** A FakeHost whose registerFeature calls and disposer calls are counted. */
function countingHost(opts: ConstructorParameters<typeof FakeHost>[0] = {}) {
  const host = new FakeHost(opts);
  const defs: CompanionFeatureDef[] = [];
  const count = { disposed: 0 };
  const register = host.registerFeature.bind(host);
  host.registerFeature = (def: CompanionFeatureDef): Disposer => {
    defs.push(def);
    return countedDisposer(register(def), count);
  };
  return { host, defs, disposedCount: () => count.disposed };
}

function setup({ layoutReady = true } = {}) {
  const app = new FakeApp();
  if (layoutReady) app.workspace.setLayoutReady();
  const notices: string[] = [];
  const registered: EventRef[] = [];
  const conn = new HostConnection(app, {
    notify: (m) => notices.push(m),
    registerEvent: (ref) => registered.push(ref),
  });
  return { app, conn, notices, registered };
}

describe("findHost", () => {
  test("returns null when no host plugin is loaded", () => {
    expect(findHost(new FakeApp())).toBeNull();
  });

  test("finds mehrpele before pele-mermaid", () => {
    const app = new FakeApp();
    const dev = new FakeHost({ hostVersion: "dev" }).install(app, "pele-mermaid", { fireReady: false });
    const main = new FakeHost({ hostVersion: "main" }).install(app, "mehrpele", { fireReady: false });
    const found = findHost(app);
    expect(found).toEqual({ id: "mehrpele", api: main });
    expect(found && "api" in found && found.api).not.toBe(dev);
  });

  test("falls back to pele-mermaid when only it is loaded", () => {
    const app = new FakeApp();
    const dev = new FakeHost().install(app, "pele-mermaid", { fireReady: false });
    expect(findHost(app)).toEqual({ id: "pele-mermaid", api: dev });
  });

  test("a compatible pele-mermaid wins over a too-old mehrpele", () => {
    const app = new FakeApp();
    new FakeHost({ apiMinor: 0 }).install(app, "mehrpele", { fireReady: false });
    const dev = new FakeHost().install(app, "pele-mermaid", { fireReady: false });
    expect(findHost(app)).toEqual({ id: "pele-mermaid", api: dev });
  });

  test("rejects a low apiMinor as too old", () => {
    const app = new FakeApp();
    new FakeHost({ apiMinor: 0 }).install(app, "mehrpele", { fireReady: false });
    expect(findHost(app)).toEqual({ id: "mehrpele", tooOld: true });
  });

  test("treats a missing apiMinor as 0", () => {
    const app = new FakeApp();
    const host = new FakeHost();
    app.plugins.plugins.mehrpele = { api: { ...host, apiMinor: undefined, registerFeature: host.registerFeature } };
    expect(findHost(app)).toEqual({ id: "mehrpele", tooOld: true });
  });

  test("rejects apiVersion 2 and falls back to apiV1", () => {
    const app = new FakeApp();
    const v1 = new FakeHost();
    const v2 = { apiVersion: 2, apiMinor: 5, registerFeature: () => () => {} };
    (app.plugins.plugins as Record<string, unknown>).mehrpele = { api: v2, apiV1: v1 };
    expect(findHost(app)).toEqual({ id: "mehrpele", api: v1 });
    (app.plugins.plugins as Record<string, unknown>).mehrpele = { api: v2 };
    expect(findHost(app)).toEqual({ id: "mehrpele", tooOld: true });
  });

  test("rejects a host whose needed members are not functions", () => {
    const app = new FakeApp();
    const host = new FakeHost();
    app.plugins.plugins.mehrpele = { api: { apiVersion: 1, apiMinor: 1, frames: host.frames } };
    expect(findHost(app)).toEqual({ id: "mehrpele", tooOld: true });
  });

  test("a loaded host with no api is too old", () => {
    const app = new FakeApp();
    app.plugins.plugins["pele-mermaid"] = {};
    expect(findHost(app)).toEqual({ id: "pele-mermaid", tooOld: true });
  });
});

describe("HostConnection", () => {
  test("attaches right away when the host is already loaded", () => {
    const { app, conn } = setup();
    const { host, defs } = countingHost({ hostVersion: "1.14.0" });
    host.install(app, "mehrpele", { fireReady: false });
    conn.start();
    expect(conn.status).toBe("attached");
    expect(conn.host).toBe(host);
    expect(conn.hostVersion).toBe("1.14.0");
    expect(defs).toHaveLength(1);
  });

  test("calls registerFeature with the right def", () => {
    const { app, conn } = setup();
    const { host, defs } = countingHost();
    host.install(app, "mehrpele", { fireReady: false });
    conn.start();
    expect(defs).toEqual([
      { id: "mehrpele-cannoli", name: "Mehrpele Flows", version: manifest.version, requiredHostMinor: 1 },
    ]);
    expect(host.features.has("mehrpele-cannoli")).toBe(true);
  });

  test("attaches when mehrpele:api-ready fires after start", () => {
    const { app, conn } = setup();
    conn.start();
    expect(conn.status).toBe("missing");
    const { host, defs } = countingHost();
    host.install(app, "mehrpele"); // layout is ready, so this fires api-ready now
    expect(conn.status).toBe("attached");
    expect(defs).toHaveLength(1);
  });

  test("re-checks on layout ready", () => {
    const { app, conn } = setup({ layoutReady: false });
    conn.start();
    expect(conn.status).toBe("missing");
    const { host, defs } = countingHost();
    host.install(app, "mehrpele", { fireReady: false }); // no event
    expect(conn.status).toBe("missing");
    app.workspace.setLayoutReady();
    expect(conn.status).toBe("attached");
    expect(defs).toHaveLength(1);
  });

  test("detaches on mehrpele:api-unload and calls the feature disposer exactly once", () => {
    const { app, conn } = setup();
    const { host, disposedCount } = countingHost();
    host.install(app, "mehrpele");
    conn.start();
    expect(conn.status).toBe("attached");
    host.unload(); // fires api-unload, then disposes features itself
    expect(conn.status).toBe("missing");
    expect(conn.host).toBeNull();
    expect(disposedCount()).toBe(1);
    app.workspace.trigger(UNLOAD);
    conn.dispose();
    expect(disposedCount()).toBe(1);
  });

  test("a spoofed api-unload while the host is live is ignored; a real unload detaches", () => {
    const { app, conn } = setup();
    const { host, disposedCount } = countingHost();
    host.install(app, "mehrpele");
    conn.start();
    app.workspace.trigger(UNLOAD, host);
    app.workspace.trigger(UNLOAD);
    expect(conn.status).toBe("attached");
    expect(conn.host).toBe(host);
    expect(disposedCount()).toBe(0);
    host.unload();
    expect(conn.status).toBe("missing");
    expect(conn.host).toBeNull();
    expect(disposedCount()).toBe(1);
  });

  test("double attach is a no-op", () => {
    const { app, conn } = setup();
    const { host, defs, disposedCount } = countingHost();
    host.install(app, "mehrpele");
    conn.start();
    app.workspace.trigger(READY);
    app.workspace.trigger(READY);
    conn.refresh();
    expect(defs).toHaveLength(1);
    expect(disposedCount()).toBe(0);
    expect(host.features.size).toBe(1);
  });

  test("attaching to a different host detaches the old one first", () => {
    const { app, conn } = setup();
    const a = countingHost({ hostVersion: "a" });
    a.host.install(app, "mehrpele");
    conn.start();
    const b = countingHost({ hostVersion: "b" });
    app.plugins.plugins.mehrpele = { api: b.host };
    app.workspace.trigger(READY);
    expect(a.disposedCount()).toBe(1);
    expect(b.defs).toHaveLength(1);
    expect(conn.hostVersion).toBe("b");
  });

  test("swapping hosts announces the new host once, with no transient missing status", () => {
    const { app, conn } = setup();
    countingHost({ hostVersion: "a" }).host.install(app, "mehrpele");
    conn.start();
    const seen: string[] = [];
    conn.onChange((s) => seen.push(`${s} ${conn.hostVersion}`));
    app.plugins.plugins.mehrpele = { api: countingHost({ hostVersion: "b" }).host };
    app.workspace.trigger(READY);
    expect(seen).toEqual(["attached b"]);
    app.workspace.trigger(READY); // same host again: nothing to announce
    expect(seen).toEqual(["attached b"]);
  });

  test("a throwing host disposer still detaches", () => {
    const { app, conn } = setup();
    const host = new FakeHost();
    host.registerFeature = () => () => {
      throw new Error("host bug");
    };
    host.install(app, "mehrpele", { fireReady: false });
    conn.start();
    expect(conn.status).toBe("attached");
    expect(() => conn.dispose()).not.toThrow();
    expect(conn.status).toBe("missing");
    expect(conn.host).toBeNull();
    expect(app.workspace.listenerCount()).toBe(0);
  });

  test("dispose() detaches and removes all listeners", () => {
    const { app, conn, registered } = setup();
    const { host, disposedCount } = countingHost();
    host.install(app, "mehrpele");
    conn.start();
    expect(app.workspace.listenerCount(READY)).toBe(1);
    expect(app.workspace.listenerCount(UNLOAD)).toBe(1);
    expect(registered).toHaveLength(2);
    conn.dispose();
    expect(app.workspace.listenerCount(READY)).toBe(0);
    expect(app.workspace.listenerCount(UNLOAD)).toBe(0);
    expect(app.workspace.listenerCount()).toBe(0);
    expect(disposedCount()).toBe(1);
    expect(host.features.size).toBe(0);
    expect(conn.status).toBe("missing");
    // An api-ready event after dispose does nothing.
    app.workspace.trigger(READY);
    expect(conn.status).toBe("missing");
  });

  test("dispose() runs no subscriber code, so a throwing subscriber can't stop unload", () => {
    const { app, conn } = setup();
    const { host, disposedCount } = countingHost();
    host.install(app, "mehrpele");
    conn.start();
    conn.onChange(() => {
      throw new Error("subscriber bug");
    });
    expect(() => conn.dispose()).not.toThrow();
    expect(disposedCount()).toBe(1);
    expect(app.workspace.listenerCount()).toBe(0);
  });

  test("a layout-ready callback after dispose does nothing", () => {
    const { app, conn, notices } = setup({ layoutReady: false });
    conn.start();
    new FakeHost({ apiMinor: 0 }).install(app, "mehrpele", { fireReady: false });
    conn.dispose();
    app.workspace.setLayoutReady();
    expect(conn.status).toBe("missing");
    expect(notices).toEqual([]);
  });

  test("shows the too-old notice once", () => {
    const { app, conn, notices } = setup({ layoutReady: false });
    new FakeHost({ apiMinor: 0 }).install(app, "mehrpele");
    conn.start();
    expect(conn.status).toBe("too-old");
    expect(notices).toEqual([]); // not before layout ready
    app.workspace.setLayoutReady(); // host fires api-ready, connection re-checks
    expect(notices).toEqual([TOO_OLD_MESSAGE]);
    app.workspace.trigger(READY);
    conn.refresh();
    expect(notices).toHaveLength(1);
    expect(TOO_OLD_MESSAGE).toBe("Mehrpele 1.1+ API needed for diagram flows");
  });

  test("no notice when the host is missing", () => {
    const { conn, notices } = setup();
    conn.start();
    expect(conn.status).toBe("missing");
    expect(notices).toEqual([]);
  });

  test("onChange reports status changes and can unsubscribe", () => {
    const { app, conn } = setup();
    const seen: string[] = [];
    const off = conn.onChange((s) => seen.push(s));
    conn.start();
    const { host } = countingHost();
    host.install(app, "mehrpele");
    host.unload();
    off();
    new FakeHost({ apiMinor: 0 }).install(app, "mehrpele");
    expect(seen).toEqual(["attached", "missing"]);
    expect(conn.status).toBe("too-old");
  });

  test("a host whose registerFeature throws does not break start()", () => {
    const { app, conn, notices } = setup();
    const host = new FakeHost();
    host.registerFeature = () => {
      throw new Error("host bug");
    };
    host.install(app, "mehrpele", { fireReady: false });
    expect(() => conn.start()).not.toThrow();
    expect(conn.status).toBe("too-old");
    expect(conn.host).toBeNull();
    expect(notices).toEqual([TOO_OLD_MESSAGE]);
    expect(() => app.workspace.trigger(READY)).not.toThrow();
    expect(notices).toHaveLength(1);
    conn.dispose();
    expect(app.workspace.listenerCount()).toBe(0);
  });

  test("start() twice adds listeners once", () => {
    const { app, conn } = setup();
    conn.start();
    conn.start();
    expect(app.workspace.listenerCount()).toBe(2);
    conn.dispose();
  });
});

describe("settings status text", () => {
  test("one line per status", () => {
    expect(statusText("missing", null)).toBe("Install Mehrpele to run flows from diagrams");
    expect(statusText("too-old", null)).toBe("Update Mehrpele to run flows from diagrams");
    expect(statusText("attached", "1.14.0")).toBe("Connected to Mehrpele 1.14.0");
  });
});
