import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayController } from "./overlay";

type Listener = (event: Event) => void;
let documentRoot: ModalElement;
let activeElement: ModalElement | null;
let documentListeners: Map<string, Listener>;
let shadows: ModalElement[];

class ModalElement {
  children: ModalElement[] = [];
  parentElement: ModalElement | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  className = "";
  id = "";
  hidden = false;
  inert = false;
  disabled = false;
  textContent = "";
  value = "";
  type = "";
  private tabIndexValue: number | null = null;
  activeElement: ModalElement | null = null;
  shadow = false;
  classList = { add: (...values: string[]) => { this.className += ` ${values.join(" ")}`; } };
  listeners = new Map<string, Listener>();
  constructor(readonly tagName: string) {}
  get tabIndex() { return this.tabIndexValue ?? (["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(this.tagName) ? 0 : -1); }
  set tabIndex(value: number) { this.tabIndexValue = value; }
  get isConnected(): boolean { return this === documentRoot || Boolean(this.parentElement?.isConnected); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  getAttribute(key: string): string | null {
    if (key.startsWith("data-")) {
      const name = key.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return this.dataset[name] ?? null;
    }
    return this.attributes.get(key) ?? null;
  }
  append(...nodes: (ModalElement | string)[]) {
    for (const node of nodes) {
      if (node instanceof ModalElement) { this.children.push(node); node.parentElement = this; }
    }
  }
  replaceChildren() { for (const child of this.children) child.parentElement = null; this.children = []; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = null; }
  attachShadow() { const shadow = new ModalElement("SHADOW"); shadow.shadow = true; shadow.parentElement = this; shadows.push(shadow); return shadow; }
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  matches(selector: string): boolean {
    return selector.split(",").some((raw) => {
      const part = raw.trim();
      if (part.startsWith(".")) return this.className.split(/\s+/).includes(part.slice(1));
      if (part === "[hidden]") return this.hidden;
      if (part === "[inert]") return this.inert;
      if (part === ":disabled") return this.disabled;
      if (part === "[tabindex]") return this.tabIndexValue !== null;
      const attribute = part.match(/^\[([^=]+)(?:="([^"]*)")?\]$/);
      if (attribute) return attribute[2] === undefined ? this.getAttribute(attribute[1]) !== null : this.getAttribute(attribute[1]) === attribute[2];
      return this.tagName.toLowerCase() === part;
    });
  }
  closest(selector: string): ModalElement | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll<T extends ModalElement>(selector: string): T[] {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) as T[];
  }
  querySelector<T extends ModalElement>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, listener); }
  focus() {
    activeElement = this;
    for (const shadow of shadows) shadow.activeElement = shadow.contains(this) ? this : null;
    const event = { composedPath: () => [this] } as unknown as FocusEvent;
    documentListeners.get("focusin")?.(event);
  }
  click() { this.listeners.get("click")?.({} as Event); }
}

function pressTab(shiftKey = false): void {
  const preventDefault = vi.fn();
  documentListeners.get("keydown")?.({ key: "Tab", shiftKey, preventDefault, stopPropagation: vi.fn() } as unknown as KeyboardEvent);
  expect(preventDefault).toHaveBeenCalled();
}

let overlay: OverlayController;
let previous: ModalElement;
beforeEach(() => {
  documentListeners = new Map();
  shadows = [];
  documentRoot = new ModalElement("HTML");
  previous = new ModalElement("BUTTON");
  documentRoot.append(previous);
  activeElement = previous;
  vi.stubGlobal("Node", ModalElement);
  vi.stubGlobal("HTMLElement", ModalElement);
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("document", {
    documentElement: documentRoot,
    get activeElement() { return activeElement; },
    createElement: (tag: string) => new ModalElement(tag.toUpperCase()),
    createElementNS: (_ns: string, tag: string) => new ModalElement(tag.toUpperCase()),
    addEventListener: (type: string, listener: Listener) => documentListeners.set(type, listener),
    removeEventListener: (type: string) => documentListeners.delete(type)
  });
  overlay = new OverlayController({ onStartSession: vi.fn(), onAction: vi.fn(), onOpenPost: vi.fn(), onDismissDailyLimit: vi.fn(), onOpenSettings: vi.fn(), onBlockingModalVisibilityChange: vi.fn() });
  overlay.mount();
});
afterEach(() => { overlay.unmount(); vi.unstubAllGlobals(); });

describe("blocking modal keyboard focus", () => {
  it("contains Tab in the prompt, preserves focus on render, and restores it on close", () => {
    overlay.setPromptVisible(true);
    expect(activeElement?.dataset.fdFocusKey).toBe("start");
    pressTab();
    expect(activeElement?.dataset.fdFocusKey).toBe("choice-10");
    pressTab(true);
    expect(activeElement?.dataset.fdFocusKey).toBe("start");
    overlay.setStatus("Waiting");
    expect(activeElement?.dataset.fdFocusKey).toBe("start");
    overlay.setPromptVisible(false);
    expect(activeElement).toBe(previous);
  });

  it("includes the custom input in the trap and restores it across renders", () => {
    overlay.setPromptVisible(true);
    shadows[0].querySelector<ModalElement>('[data-fd-focus-key="choice-custom"]')!.click();
    expect(activeElement?.dataset.fdFocusKey).toBe("custom-input");
    overlay.setPromptPostLimitCap(5);
    expect(activeElement?.dataset.fdFocusKey).toBe("custom-input");
    pressTab();
    expect(activeElement?.dataset.fdFocusKey).toBe("start");
  });

  it("moves focus into the daily modal when it replaces the prompt", () => {
    overlay.setPromptVisible(true);
    overlay.setDailyLimitReached(true);
    pressTab();
    expect(activeElement?.dataset.fdFocusKey).toBe("daily-close");
    pressTab(true);
    expect(activeElement?.dataset.fdFocusKey).toBe("daily-settings");
    expect(shadows[0].querySelector(".fd-session-gate")).toBeNull();
    overlay.setPromptVisible(false);
    overlay.setDailyLimitReached(false);
    expect(activeElement).toBe(previous);
  });

  it("redirects attempted background focus while a modal is open", () => {
    overlay.setPromptVisible(true);
    previous.focus();
    expect(activeElement?.dataset.fdFocusKey).toBe("start");
  });
});
