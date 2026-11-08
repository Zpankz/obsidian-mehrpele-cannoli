// A stand-in DOM element for overlay layers (bun test has no DOM). Only enough to check
// ownership and removal. Code that draws into a layer (createDiv, classList, empty, …)
// needs a DOM-backed `createLayer`, e.g. from happy-dom.

export interface FakeElement {
  readonly layerId: string;
  readonly children: unknown[];
  readonly dataset: Record<string, string>;
  isConnected: boolean;
  appendChild<T>(child: T): T;
  replaceChildren(...children: unknown[]): void;
  remove(): void;
}

export function fakeElement(layerId: string): FakeElement {
  const el: FakeElement = {
    layerId,
    children: [],
    dataset: { layer: layerId },
    isConnected: true,
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      el.children.splice(0, el.children.length, ...children);
    },
    remove() {
      el.isConnected = false;
    },
  };
  return el;
}
