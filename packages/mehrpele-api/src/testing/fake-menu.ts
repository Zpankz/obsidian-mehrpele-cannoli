// The part of Obsidian's Menu that a companion's `addMenuItems` callback touches.

export class FakeMenuItem {
  title = "";
  icon: string | null = null;
  section: string | null = null;
  disabled = false;
  handler: ((evt: MouseEvent | KeyboardEvent) => unknown) | null = null;
  setTitle(title: string | DocumentFragment): this {
    this.title = typeof title === "string" ? title : title.textContent ?? "";
    return this;
  }
  setIcon(icon: string | null): this {
    this.icon = icon;
    return this;
  }
  setSection(section: string): this {
    this.section = section;
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
  setChecked(_checked: boolean | null): this {
    return this;
  }
  onClick(cb: (evt: MouseEvent | KeyboardEvent) => unknown): this {
    this.handler = cb;
    return this;
  }
}

export class FakeMenu {
  items: FakeMenuItem[] = [];
  addItem(cb: (item: FakeMenuItem) => unknown): this {
    const item = new FakeMenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  titles(): string[] {
    return this.items.map((i) => i.title);
  }
}
