import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionDispatcher } from "@/core/action-dispatcher";
import { DeckEngine } from "@/core/deck-engine";
import type { Adapter, ActionResult, PostHandle, PostMeta } from "@/types/adapter";
import type { DailyLimitsConfig, DailyUsage, SessionConfig } from "@/types/session";

vi.mock("@/shared/storage", () => ({
  setSessionSnapshot: vi.fn(async () => undefined),
  setDailyUsage: vi.fn(async <T>(usage: T) => usage),
  clearSessionSnapshot: vi.fn(async () => undefined)
}));

type RectState = {
  top: number;
  height: number;
};

class MockEventTarget {
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) {
      return;
    }

    const bucket = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) {
      return;
    }

    const bucket = this.listeners.get(type);
    if (!bucket) {
      return;
    }

    bucket.delete(listener);
    if (!bucket.size) {
      this.listeners.delete(type);
    }
  }

  emit(type: string): void {
    const event = { type } as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener.call(this as unknown as EventTarget, event);
      } else {
        listener.handleEvent(event);
      }
    }
  }
}

class MockScrollableElement extends MockEventTarget {
  scrollTop = 0;
  scrollHeight = 4_000;
  clientHeight = 600;
}

class MockWindow extends MockEventTarget {
  innerHeight = 600;
  scrollY = 0;
  pageYOffset = 0;
  private nextRafId = 1;
  private readonly rafCallbacks = new Map<number, FrameRequestCallback>();
  setTimeout = ((_handler: TimerHandler, _timeout?: number, ..._args: unknown[]) => 1) as typeof window.setTimeout;
  clearTimeout = ((_id: number) => undefined) as typeof window.clearTimeout;
  setInterval = ((_handler: TimerHandler, _timeout?: number, ..._args: unknown[]) => 1) as typeof window.setInterval;
  clearInterval = ((_id: number) => undefined) as typeof window.clearInterval;
  requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = this.nextRafId;
    this.nextRafId += 1;
    this.rafCallbacks.set(id, callback);
    return id;
  }) as typeof window.requestAnimationFrame;
  cancelAnimationFrame = ((id: number) => {
    this.rafCallbacks.delete(id);
  }) as typeof window.cancelAnimationFrame;

  flushAnimationFrames(): void {
    const callbacks = Array.from(this.rafCallbacks.values());
    this.rafCallbacks.clear();
    for (const callback of callbacks) {
      callback(0);
    }
  }
}

class MockDocument extends MockEventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  readonly scrollingRoot = new MockScrollableElement();
  scrollingElement: Element | null = this.scrollingRoot as unknown as Element;
  documentElement = this.scrollingRoot as unknown as HTMLElement;
  body = this.scrollingRoot as unknown as HTMLElement;
  private readonly queryMap = new Map<string, Element | null>();

  setScrollTop(top: number): void {
    this.scrollingRoot.scrollTop = top;
  }

  setQueryResult(selector: string, value: Element | null): void {
    this.queryMap.set(selector, value);
  }

  querySelector(_selector: string): Element | null {
    return this.queryMap.get(_selector) ?? null;
  }

  querySelectorAll<T extends Element>(_selector: string): NodeListOf<T> {
    return [] as unknown as NodeListOf<T>;
  }
}

class FakeAdapter implements Adapter {
  readonly id = "x";
  readonly name = "X / Twitter";
  private onFeedChange: (() => void) | null = null;

  constructor(private handles: PostHandle[]) {}

  isSupportedUrl(_url: string): boolean {
    return true;
  }

  setHandles(next: PostHandle[]): void {
    this.handles = next;
  }

  emitFeedMutation(): void {
    this.onFeedChange?.();
  }

  getFeedItems(): PostHandle[] {
    return this.handles;
  }

  focusItem(_handle: PostHandle): void {}

  getPostMeta(handle: PostHandle): PostMeta | null {
    return {
      id: handle.id,
      text: handle.id,
      media: [],
      siteLabel: "X / Twitter"
    };
  }

  notInterested(_handle: PostHandle): ActionResult {
    return { ok: true };
  }

  bookmark(_handle: PostHandle): ActionResult {
    return { ok: true };
  }

  observeFeedChanges(onChange: () => void): () => void {
    this.onFeedChange = onChange;
    return () => {
      if (this.onFeedChange === onChange) {
        this.onFeedChange = null;
      }
    };
  }
}

function buildDailyUsage(): DailyUsage {
  return {
    dateKey: "2026-02-21",
    global: {
      postsViewed: 0,
      activeMs: 0,
      emergencyMs: 0
    },
    perSite: {}
  };
}

function buildRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    left: 0,
    top,
    width: 600,
    height,
    right: 600,
    bottom: top + height,
    toJSON: () => ({})
  } as DOMRect;
}

function buildHandle(id: string, rectState: RectState): PostHandle {
  const attributes = new Map<string, string>();
  const element = {
    getBoundingClientRect: () => buildRect(rectState.top, rectState.height),
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    removeAttribute: (name: string) => {
      attributes.delete(name);
    },
    hasAttribute: (name: string) => attributes.has(name),
    getAttribute: (name: string) => attributes.get(name) ?? null
  } as unknown as HTMLElement;

  return { id, element };
}

const DEFAULT_CONFIG: SessionConfig = {
  mode: "posts",
  themeMode: "system",
  postLimit: 20,
  timeLimitMinutes: 10,
  minimalMode: true
};

const DEFAULT_DAILY_LIMITS: DailyLimitsConfig = {
  global: {
    maxPosts: 0,
    maxMinutes: 0
  },
  perSite: {}
};

describe("DeckEngine startup and mutation focus behavior", () => {
  const globalRef = globalThis as typeof globalThis & { window?: Window; document?: Document };
  let originalWindow: Window | undefined;
  let originalDocument: Document | undefined;
  let mockWindow: MockWindow;
  let mockDocument: MockDocument;
  let activeEngine: DeckEngine | null = null;

  beforeEach(() => {
    originalWindow = globalRef.window;
    originalDocument = globalRef.document;

    mockWindow = new MockWindow();
    mockDocument = new MockDocument();

    Object.defineProperty(globalRef, "window", {
      value: mockWindow as unknown as Window,
      configurable: true,
      writable: true
    });

    Object.defineProperty(globalRef, "document", {
      value: mockDocument as unknown as Document,
      configurable: true,
      writable: true
    });
  });

  afterEach(async () => {
    if (activeEngine) {
      await activeEngine.stop("manual");
      activeEngine = null;
    }

    if (originalWindow) {
      Object.defineProperty(globalRef, "window", {
        value: originalWindow,
        configurable: true,
        writable: true
      });
    } else {
      Reflect.deleteProperty(globalRef, "window");
    }

    if (originalDocument) {
      Object.defineProperty(globalRef, "document", {
        value: originalDocument,
        configurable: true,
        writable: true
      });
    } else {
      Reflect.deleteProperty(globalRef, "document");
    }

    vi.clearAllMocks();
  });

  it("keeps the first visible post focused across initial feed mutations", async () => {
    const firstRect: RectState = { top: 0, height: 120 };
    const secondRect: RectState = { top: 160, height: 120 };
    const thirdRect: RectState = { top: 320, height: 120 };

    const adapter = new FakeAdapter([
      buildHandle("post-1", firstRect),
      buildHandle("post-2", secondRect),
      buildHandle("post-3", thirdRect)
    ]);

    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    const started = await activeEngine.start(DEFAULT_CONFIG);

    expect(started).toBe(true);
    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-1");
    expect(activeEngine.getViewState()?.snapshot.stats.viewedCount).toBe(1);

    // Keep first post visible while feed mutations occur.
    firstRect.top = 10;
    adapter.emitFeedMutation();

    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-1");
    expect(activeEngine.getViewState()?.snapshot.stats.viewedCount).toBe(1);
  });

  it("recovers focus and counts progress when the focused post disappears from view", async () => {
    const firstRect: RectState = { top: 0, height: 120 };
    const secondRect: RectState = { top: 190, height: 120 };
    const thirdRect: RectState = { top: 390, height: 120 };

    const adapter = new FakeAdapter([
      buildHandle("post-1", firstRect),
      buildHandle("post-2", secondRect),
      buildHandle("post-3", thirdRect)
    ]);

    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    const started = await activeEngine.start(DEFAULT_CONFIG);

    expect(started).toBe(true);
    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-1");
    expect(activeEngine.getViewState()?.snapshot.stats.viewedCount).toBe(1);

    // Simulate feed hydration moving the focused post out of viewport.
    firstRect.top = -260;
    adapter.emitFeedMutation();

    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-2");
    expect(activeEngine.getViewState()?.snapshot.stats.viewedCount).toBe(2);

    // A second mutation while focused post remains visible should not count again.
    adapter.emitFeedMutation();
    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-2");
    expect(activeEngine.getViewState()?.snapshot.stats.viewedCount).toBe(2);
  });

  it("still allows scroll-driven focus movement after startup", async () => {
    const firstRect: RectState = { top: 0, height: 120 };
    const secondRect: RectState = { top: 280, height: 120 };
    const thirdRect: RectState = { top: 500, height: 120 };

    const adapter = new FakeAdapter([
      buildHandle("post-1", firstRect),
      buildHandle("post-2", secondRect),
      buildHandle("post-3", thirdRect)
    ]);

    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    const started = await activeEngine.start(DEFAULT_CONFIG);

    expect(started).toBe(true);
    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-1");

    // Simulate user scroll where another post becomes nearest to viewport center.
    mockWindow.scrollY = 260;
    mockWindow.pageYOffset = 260;
    mockDocument.setScrollTop(260);
    firstRect.top = -70;
    secondRect.top = 170;
    thirdRect.top = 430;
    mockWindow.emit("scroll");
    mockWindow.flushAnimationFrames();

    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-2");
    expect(activeEngine.getViewState()?.snapshot.stats.viewedCount).toBe(2);
  });

  it("re-focuses the first visible post when returning to top after scrolling down", async () => {
    const firstRect: RectState = { top: 0, height: 120 };
    const secondRect: RectState = { top: 280, height: 120 };
    const thirdRect: RectState = { top: 500, height: 120 };

    const adapter = new FakeAdapter([
      buildHandle("post-1", firstRect),
      buildHandle("post-2", secondRect),
      buildHandle("post-3", thirdRect)
    ]);

    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    const started = await activeEngine.start(DEFAULT_CONFIG);

    expect(started).toBe(true);
    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-1");

    // Scroll down first so center-based focus moves away from the first post.
    mockWindow.scrollY = 260;
    mockWindow.pageYOffset = 260;
    mockDocument.setScrollTop(260);
    firstRect.top = -90;
    secondRect.top = 170;
    thirdRect.top = 430;
    mockWindow.emit("scroll");
    mockWindow.flushAnimationFrames();
    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-2");

    // Return to top where center would normally still prefer post-2.
    mockWindow.scrollY = 0;
    mockWindow.pageYOffset = 0;
    mockDocument.setScrollTop(0);
    firstRect.top = 36;
    secondRect.top = 210;
    thirdRect.top = 470;
    mockWindow.emit("scroll");
    mockWindow.flushAnimationFrames();

    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-1");
  });

  it("does not remain top-locked when an active feed scroller has moved", async () => {
    const firstRect: RectState = { top: 40, height: 120 };
    const secondRect: RectState = { top: 240, height: 120 };
    const thirdRect: RectState = { top: 500, height: 120 };

    const adapter = new FakeAdapter([
      buildHandle("post-1", firstRect),
      buildHandle("post-2", secondRect),
      buildHandle("post-3", thirdRect)
    ]);

    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    const started = await activeEngine.start(DEFAULT_CONFIG);

    expect(started).toBe(true);
    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-1");

    // Simulate nested feed scroller movement while document/body stay at 0.
    const nestedMain = new MockScrollableElement();
    nestedMain.scrollTop = 220;
    nestedMain.scrollHeight = 5_000;
    nestedMain.clientHeight = 600;
    mockDocument.setQueryResult("main", nestedMain as unknown as Element);

    mockWindow.emit("scroll");
    mockWindow.flushAnimationFrames();

    // Focus should use center strategy once any active feed scroller moved.
    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-2");
  });
});
