// A minimal stand-in for the "obsidian" module (the real package ships types only). Tests call
// `mock.module("obsidian", () => fakeObsidian)` before importing src, then read `obsidianLog`.
// Only what the tests assert on is recorded; every other control is inert.
import type { EventRef } from "obsidian";

export interface FakeButton {
  text: string;
  click: () => void;
}

/** One rendered `Setting`. */
export interface FakeSetting {
  name: string;
  desc: string;
  classes: string[];
  buttons: FakeButton[];
}

export const obsidianLog = {
  notices: [] as string[],
  settings: [] as FakeSetting[],
  reset(): void {
    this.notices.length = 0;
    this.settings.length = 0;
  },
};

/**
 * A component or element whose every method returns itself: text fields, toggles, dropdowns,
 * DOM helpers. `inert.anything(...).other(...)` is always valid and records nothing.
 */
export function inert(): any {
  const target = () => {};
  const proxy: any = new Proxy(target, {
    get: (_t, key) => (key === "then" ? undefined : proxy),
    apply: () => proxy,
  });
  return proxy;
}

export class FakeContainerEl {
  emptied = 0;
  empty(): void {
    this.emptied++;
  }
  addClass(): void {}
  createEl(): any {
    return inert();
  }
  createDiv(): any {
    return inert();
  }
}

class Notice {
  constructor(message: string) {
    obsidianLog.notices.push(message);
  }
}

class Plugin {
  events: EventRef[] = [];
  tabs: unknown[] = [];
  views: string[] = [];
  commands: string[] = [];
  constructor(
    public app: unknown,
    public manifest?: unknown,
  ) {}
  private cleanups: (() => unknown)[] = [];
  registerEvent(ref: EventRef): void {
    this.events.push(ref);
  }
  register(cb: () => unknown): void {
    this.cleanups.push(cb);
  }
  onunload(): void {}
  /** As Obsidian's Component.unload: onunload, then every register() callback and event ref. */
  unload(): void {
    this.onunload();
    for (const cb of this.cleanups.splice(0)) cb();
    const workspace = (this.app as { workspace: { offref(ref: EventRef): void } }).workspace;
    for (const ref of this.events.splice(0)) workspace.offref(ref);
  }
  addSettingTab(tab: unknown): void {
    this.tabs.push(tab);
  }
  registerView(type: string): void {
    this.views.push(type);
  }
  addCommand(command: { id: string }): void {
    this.commands.push(command.id);
  }
  addStatusBarItem(): any {
    return inert();
  }
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(): Promise<void> {}
}

class PluginSettingTab {
  containerEl = new FakeContainerEl();
  constructor(
    public app: unknown,
    public plugin: unknown,
  ) {}
}

class Setting {
  private entry: FakeSetting = { name: "", desc: "", classes: [], buttons: [] };
  settingEl = { addClass: (...classes: string[]) => this.entry.classes.push(...classes) };
  controlEl = inert();
  descEl = inert();
  nameEl = inert();
  constructor(_containerEl: unknown) {
    obsidianLog.settings.push(this.entry);
    // Text, toggle, dropdown and other controls get an inert component.
    return new Proxy(this, {
      get: (self, key, receiver) => {
        if (key in self) return Reflect.get(self, key, receiver);
        return (cb?: (component: unknown) => void) => {
          if (typeof cb === "function") cb(inert());
          return receiver;
        };
      },
    });
  }
  setName(name: string): this {
    this.entry.name = name;
    return this;
  }
  setDesc(desc: string): this {
    this.entry.desc = desc;
    return this;
  }
  addButton(cb: (b: { setButtonText(t: string): unknown; onClick(f: () => void): unknown }) => void): this {
    const button: FakeButton = { text: "", click: () => {} };
    const b: any = new Proxy(
      {
        setButtonText: (t: string) => ((button.text = t), b),
        onClick: (f: () => void) => ((button.click = f), b),
      },
      { get: (self, key) => (key in self ? self[key as keyof typeof self] : () => b) },
    );
    cb(b);
    this.entry.buttons.push(button);
    return this;
  }
}

class Inert {
  constructor() {
    return inert();
  }
}

export const fakeObsidian = {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  ItemView: class {},
  MarkdownView: class {},
  Modal: class {},
  TFile: class {},
  SettingGroup: Inert,
  SecretComponent: Inert,
  requestUrl: async () => ({ status: 200, headers: {}, text: "", json: null }),
  resolveSubpath: () => null,
};
