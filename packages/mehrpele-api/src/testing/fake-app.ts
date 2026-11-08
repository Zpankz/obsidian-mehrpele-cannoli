// The part of Obsidian's `App` a companion touches to find the host: workspace events,
// layout readiness and the plugin registry.

import type { EventRef } from "obsidian";
import type { MehrpeleHostPlugin } from "../index";

interface Listener {
  name: string;
  cb: (...args: unknown[]) => unknown;
  ctx?: unknown;
}

export class FakeWorkspace {
  layoutReady = false;
  private listeners: Listener[] = [];
  private layoutQueue: Array<() => unknown> = [];

  on(name: string, cb: (...args: unknown[]) => unknown, ctx?: unknown): EventRef {
    const ref: Listener = { name, cb, ctx };
    this.listeners.push(ref);
    return ref;
  }

  offref(ref: EventRef): void {
    this.listeners = this.listeners.filter((l) => l !== (ref as unknown as Listener));
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const l of [...this.listeners]) if (l.name === name) l.cb.apply(l.ctx, args);
  }

  onLayoutReady(cb: () => unknown): void {
    if (this.layoutReady) cb();
    else this.layoutQueue.push(cb);
  }

  /** Simulates Obsidian finishing its layout. */
  setLayoutReady(): void {
    this.layoutReady = true;
    const queued = this.layoutQueue.splice(0);
    for (const cb of queued) cb();
  }

  listenerCount(name?: string): number {
    return name ? this.listeners.filter((l) => l.name === name).length : this.listeners.length;
  }
}

export class FakeApp {
  workspace = new FakeWorkspace();
  plugins = {
    plugins: {} as Record<string, MehrpeleHostPlugin>,
    manifests: {} as Record<string, { id: string; version: string }>,
    enabledPlugins: new Set<string>(),
  };
}
