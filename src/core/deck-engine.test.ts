import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUsageDelta, isDailyLimitReached, localDateKey } from "@/core/daily-counter";
import { acknowledgeDailyView, commitDailyView, reserveDailyView, releaseDailyView, clearOwnedSessionSnapshot, saveOwnedSessionSnapshot } from "@/shared/runtime-state";
import { ActionDispatcher } from "@/core/action-dispatcher";
import { DeckEngine } from "@/core/deck-engine";
import type { Adapter, ActionResult, PostHandle, PostMeta } from "@/types/adapter";
import type { DailyLimitsConfig, DailyUsage, SessionConfig, SessionSnapshot } from "@/types/session";

const dailyStore = vi.hoisted(() => ({
  limits: { global: { maxPosts: 0 }, perSite: {} } as DailyLimitsConfig,
  usage: { dateKey: "", global: { postsViewed: 0 }, perSite: {} } as DailyUsage,
  snapshot: null as SessionSnapshot | null,
  committed: new Set<string>()
}));

vi.mock("@/shared/runtime-state", () => ({
  saveOwnedSessionSnapshot: vi.fn(async (snapshot: SessionSnapshot) => {
    dailyStore.snapshot = structuredClone(snapshot);
    return snapshot;
  }),
  clearOwnedSessionSnapshot: vi.fn(async () => { dailyStore.snapshot = null; }),
  reserveDailyView: vi.fn(async () => ({ allowed: !isDailyLimitReached(dailyStore.limits, dailyStore.usage, "x"), usage: dailyStore.usage, limits: dailyStore.limits })),
  commitDailyView: vi.fn(async (view: { progressKey: string; requestId: string; postId: string }) => {
    const snapshot = dailyStore.snapshot!;
    if (!snapshot.stats.viewedPostIds.includes(view.progressKey)) {
      dailyStore.usage = applyUsageDelta(dailyStore.usage, "x", { postsViewed: 1 });
      dailyStore.committed.add(view.requestId);
      snapshot.stats.viewedPostIds.push(view.progressKey);
      snapshot.stats.viewedCount = snapshot.stats.viewedPostIds.length;
      snapshot.focusedPostId = view.postId;
    }
    return { allowed: true, usage: dailyStore.usage, limits: dailyStore.limits, snapshot: structuredClone(snapshot) };
  }),
  releaseDailyView: vi.fn(async (view: { progressKey: string; requestId: string }) => {
    if (dailyStore.committed.delete(view.requestId)) {
      dailyStore.usage = { ...dailyStore.usage, global: { postsViewed: dailyStore.usage.global.postsViewed - 1 }, perSite: { x: { postsViewed: dailyStore.usage.perSite.x.postsViewed - 1 } } };
      if (dailyStore.snapshot) {
        dailyStore.snapshot.stats.viewedPostIds = dailyStore.snapshot.stats.viewedPostIds.filter((key) => key !== view.progressKey);
        dailyStore.snapshot.stats.viewedCount = dailyStore.snapshot.stats.viewedPostIds.length;
      }
    }
    return { allowed: true, usage: dailyStore.usage, limits: dailyStore.limits };
  }),
  acknowledgeDailyView: vi.fn(async (view: { requestId: string }) => { dailyStore.committed.delete(view.requestId); })
}));

async function settleFocus(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
}

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

  notInterested(_handle: PostHandle, _isCurrent?: () => boolean): ActionResult | Promise<ActionResult> {
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
    dateKey: localDateKey(),
    global: {
      postsViewed: 0
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
    isConnected: true,
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
  themeMode: "system",
  postLimit: 20,
  minimalMode: true
};

const DEFAULT_DAILY_LIMITS: DailyLimitsConfig = {
  global: {
    maxPosts: 0
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
    dailyStore.limits = DEFAULT_DAILY_LIMITS;
    dailyStore.usage = buildDailyUsage();
    dailyStore.snapshot = null;
    dailyStore.committed.clear();
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
    await settleFocus();

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
    await settleFocus();

    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-2");
    expect(activeEngine.getViewState()?.snapshot.stats.viewedCount).toBe(2);

    // A second mutation while focused post remains visible should not count again.
    adapter.emitFeedMutation();
    await settleFocus();
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
    await settleFocus();

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
    await settleFocus();
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
    await settleFocus();

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
    await settleFocus();

    // Focus should use center strategy once any active feed scroller moved.
    expect(activeEngine.getViewState()?.snapshot.focusedPostId).toBe("post-2");
  });
  it("counts unseen recovery posts even when restoration requests no count", async () => {
    const adapter = new FakeAdapter([buildHandle("a", { top: 0, height: 120 })]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    await activeEngine.pause("details");
    adapter.setHandles([buildHandle("b", { top: 0, height: 120 })]);
    await activeEngine.resume();
    await activeEngine.focusNearestToViewportCenter(true, false);
    expect(activeEngine.getViewState()?.snapshot.stats.viewedPostIds).toEqual(["a", "b"]);
    expect(dailyStore.usage.global.postsViewed).toBe(2);
    await activeEngine.restoreFocus("b", false);
    expect(dailyStore.usage.global.postsViewed).toBe(2);
  });

  it("records views immediately without waiting for the snapshot debounce", async () => {
    const adapter = new FakeAdapter([buildHandle("a", { top: 0, height: 120 })]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    expect(reserveDailyView).toHaveBeenCalledTimes(1);
    expect(saveOwnedSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(dailyStore.snapshot?.stats.viewedPostIds).toEqual(["a"]);
    await activeEngine.stop();
    expect(dailyStore.usage.global.postsViewed).toBe(1);
  });

  it("respects both daily and session limits on the final view", async () => {
    dailyStore.limits = { global: { maxPosts: 1 }, perSite: {} };
    const onComplete = vi.fn();
    const onDailyLimitReached = vi.fn();
    const adapter = new FakeAdapter([buildHandle("a", { top: 0, height: 120 })]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), dailyStore.limits, buildDailyUsage(), { onComplete, onDailyLimitReached });
    await activeEngine.start({ ...DEFAULT_CONFIG, postLimit: 1 });
    expect(activeEngine.getPhase()).toBe("completed");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onDailyLimitReached).toHaveBeenCalledTimes(1);
  });

  it("blocks new focus if another tab consumed the last daily view", async () => {
    dailyStore.limits = { global: { maxPosts: 1 }, perSite: {} };
    dailyStore.usage = { ...buildDailyUsage(), global: { postsViewed: 1 } };
    const adapter = new FakeAdapter([buildHandle("a", { top: 0, height: 120 })]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    expect(activeEngine.getPhase()).toBe("paused");
    expect(activeEngine.getFocusedPostId()).toBeNull();
    expect(activeEngine.getViewState()?.snapshot.stats.viewedCount).toBe(0);
  });

  it("enforces changed limits and releases blocking after a reset", async () => {
    const adapter = new FakeAdapter([buildHandle("a", { top: 0, height: 120 })]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    activeEngine.setDailyContext({ global: { maxPosts: 1 }, perSite: {} }, dailyStore.usage);
    expect(activeEngine.getPhase()).toBe("paused");
    activeEngine.setDailyContext({ global: { maxPosts: 1 }, perSite: {} }, buildDailyUsage());
    expect(activeEngine.getPhase()).toBe("active");
    expect(activeEngine.getDailyUsage().global.postsViewed).toBe(0);
  });

  it("does not reveal a recycled element while its daily view is pending", async () => {
    const original = buildHandle("a", { top: 0, height: 120 });
    const adapter = new FakeAdapter([original]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    const replacement = { id: "b", element: original.element };
    adapter.setHandles([replacement]);
    let release!: (value: Awaited<ReturnType<typeof reserveDailyView>>) => void;
    vi.mocked(reserveDailyView).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const recovered = activeEngine.focusNearestToViewportCenter(true);
    expect(activeEngine.getViewState()?.focusedHandle).toBeNull();
    release({ allowed: true, limits: DEFAULT_DAILY_LIMITS, usage: { ...buildDailyUsage(), global: { postsViewed: 2 } } });
    await recovered;
    expect(activeEngine.getViewState()?.snapshot.stats.viewedPostIds).toEqual(["a", "b"]);
  });

  it("restores progress from the committed snapshot before the debounce and never charges it twice", async () => {
    const adapter = new FakeAdapter([buildHandle("a", { top: 0, height: 120 }), buildHandle("b", { top: 150, height: 120 })]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    await activeEngine.next();
    const persisted = structuredClone(dailyStore.snapshot!);
    expect(persisted.stats.viewedPostIds).toEqual(["a", "b"]);
    await activeEngine.dispose();
    expect(clearOwnedSessionSnapshot).not.toHaveBeenCalled();
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, dailyStore.usage);
    await activeEngine.start(DEFAULT_CONFIG, persisted);
    expect(activeEngine.getFocusedPostId()).toBe("b");
    expect(activeEngine.getViewState()?.snapshot.stats.viewedCount).toBe(2);
    expect(dailyStore.usage.global.postsViewed).toBe(2);
  });

  it("does not charge a replacement when recovered progress already meets the target", async () => {
    const adapter = new FakeAdapter([buildHandle("a", { top: 0, height: 120 })]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    const persisted = structuredClone(dailyStore.snapshot!);
    await activeEngine.dispose();
    adapter.setHandles([buildHandle("b", { top: 0, height: 120 })]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, dailyStore.usage);
    await activeEngine.start({ ...DEFAULT_CONFIG, postLimit: 1 }, persisted);
    expect(activeEngine.getPhase()).toBe("completed");
    expect(dailyStore.usage.global.postsViewed).toBe(1);
  });

  it.each(["reserve", "commit"] as const)("reconciles cancelled %s requests on pause, stop, navigation, recycling and disposal", async (stage) => {
    for (const change of ["pause", "stop", "navigation", "recycle", "dispose"] as const) {
      dailyStore.snapshot = null;
      dailyStore.usage = buildDailyUsage();
      dailyStore.committed.clear();
      vi.mocked(clearOwnedSessionSnapshot).mockClear();
      let canCount = true;
      const a = buildHandle("a", { top: 0, height: 120 });
      const b = buildHandle("b", { top: 150, height: 120 });
      const adapter = new FakeAdapter([a, b]);
      activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, dailyStore.usage, { canCountProgress: () => canCount });
      await activeEngine.start(DEFAULT_CONFIG);
      const request = stage === "reserve" ? vi.mocked(reserveDailyView) : vi.mocked(commitDailyView);
      const original = request.getMockImplementation()!;
      let release!: () => void;
      request.mockImplementationOnce(async (view) => {
        const result = await original(view);
        await new Promise<void>((resolve) => { release = resolve; });
        return result;
      });
      const pending = activeEngine.next();
      await settleFocus();
      expect(activeEngine.getFocusedPostId()).toBe("a");
      let disposal: Promise<void> | undefined;
      if (change === "pause") await activeEngine.pause("details");
      if (change === "stop") disposal = activeEngine.stop();
      if (change === "dispose") disposal = activeEngine.dispose();
      if (change === "navigation") canCount = false;
      if (change === "recycle") adapter.setHandles([a, { id: "c", element: b.element }]);
      release();
      expect(await pending).toBe(false);
      await disposal;
      expect(dailyStore.usage.global.postsViewed).toBe(1);
      expect(releaseDailyView).toHaveBeenCalled();
      if (change === "stop") expect(dailyStore.snapshot).toBeNull();
      else {
        expect((dailyStore.snapshot as SessionSnapshot | null)?.stats.viewedPostIds).toEqual(["a"]);
        if (change === "dispose") expect(clearOwnedSessionSnapshot).not.toHaveBeenCalled();
      }
      await activeEngine.dispose();
      const persisted = dailyStore.snapshot;
      if (persisted) {
        adapter.setHandles([a, b]);
        activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, dailyStore.usage);
        await activeEngine.start(DEFAULT_CONFIG, persisted);
        await activeEngine.next();
        expect(dailyStore.usage.global.postsViewed).toBe(2);
        await activeEngine.stop();
      }
    }
  });

  it("keeps interrupted resume recoverable while its initial replacement request is pending", async () => {
    const adapter = new FakeAdapter([buildHandle("a", { top: 0, height: 120 })]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    const snapshot = structuredClone(dailyStore.snapshot!);
    await activeEngine.dispose();
    adapter.setHandles([buildHandle("b", { top: 0, height: 120 })]);
    let release!: () => void;
    const original = vi.mocked(reserveDailyView).getMockImplementation()!;
    vi.mocked(reserveDailyView).mockImplementationOnce(async (view) => {
      const result = await original(view);
      await new Promise<void>((resolve) => { release = resolve; });
      return result;
    });
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, dailyStore.usage);
    const starting = activeEngine.start(DEFAULT_CONFIG, snapshot);
    await settleFocus();
    const cancelled = activeEngine.dispose();
    release();
    await starting; await cancelled;
    expect(clearOwnedSessionSnapshot).not.toHaveBeenCalled();
    expect(dailyStore.snapshot?.stats.viewedPostIds).toEqual(["a"]);
    expect(dailyStore.usage.global.postsViewed).toBe(1);
  });

  it("does not expose a new card when its commit fails", async () => {
    const adapter = new FakeAdapter([buildHandle("a", { top: 0, height: 120 }), buildHandle("b", { top: 150, height: 120 })]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    vi.mocked(commitDailyView).mockRejectedValueOnce(new Error("write failed"));
    expect(await activeEngine.next()).toBe(false);
    expect(activeEngine.getFocusedPostId()).toBe("a");
    expect(dailyStore.usage.global.postsViewed).toBe(1);
  });

  it("undoes a durable commit if its response is lost before exposure", async () => {
    const adapter = new FakeAdapter([buildHandle("a", { top: 0, height: 120 }), buildHandle("b", { top: 150, height: 120 })]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    const original = vi.mocked(commitDailyView).getMockImplementation()!;
    vi.mocked(commitDailyView).mockImplementationOnce(async (view) => {
      await original(view);
      throw new Error("response lost");
    });
    expect(await activeEngine.next()).toBe(false);
    expect(activeEngine.getFocusedPostId()).toBe("a");
    expect(dailyStore.usage.global.postsViewed).toBe(1);
    expect(dailyStore.snapshot?.stats.viewedPostIds).toEqual(["a"]);
  });

  it("retries unresolved cancellation during disposal before permitting snapshot deletion", async () => {
    const adapter = new FakeAdapter([buildHandle("a", { top: 0, height: 120 }), buildHandle("b", { top: 150, height: 120 })]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    const original = vi.mocked(commitDailyView).getMockImplementation()!;
    let release!: () => void;
    vi.mocked(commitDailyView).mockImplementationOnce(async (view) => {
      const result = await original(view);
      await new Promise<void>((resolve) => { release = resolve; });
      return result;
    });
    const pending = activeEngine.next();
    await settleFocus(); await activeEngine.pause("details");
    vi.mocked(releaseDailyView).mockRejectedValueOnce(new Error("unavailable")).mockRejectedValueOnce(new Error("unavailable"));
    release();
    expect(await pending).toBe(false);
    expect(dailyStore.usage.global.postsViewed).toBe(2);
    await activeEngine.dispose();
    expect(dailyStore.usage.global.postsViewed).toBe(1);
    expect(dailyStore.snapshot?.stats.viewedPostIds).toEqual(["a"]);
    expect(clearOwnedSessionSnapshot).not.toHaveBeenCalled();
  });

  it("rejects queued actions after pause, stop, or identity reuse", async () => {
    for (const change of ["pause", "stop", "reuse"] as const) {
      const handle = buildHandle("a", { top: 0, height: 120 });
      const adapter = new FakeAdapter([handle]);
      const bookmark = vi.spyOn(adapter, "bookmark");
      let execute!: () => Promise<ActionResult>;
      const dispatcher = { dispatch: (action: () => Promise<ActionResult>) => {
        execute = action;
        return new Promise<ActionResult>((resolve) => { finish = resolve; });
      } } as unknown as ActionDispatcher;
      let finish!: (result: ActionResult) => void;
      activeEngine = new DeckEngine(adapter, dispatcher, DEFAULT_DAILY_LIMITS, buildDailyUsage());
      await activeEngine.start(DEFAULT_CONFIG);
      const action = activeEngine.runAction("bookmark", true);
      if (change === "pause") await activeEngine.pause("details");
      if (change === "stop") await activeEngine.stop();
      if (change === "reuse") adapter.setHandles([{ id: "b", element: handle.element }]);
      finish(await execute());
      expect((await action).ok).toBe(false);
      expect(bookmark).not.toHaveBeenCalled();
      await activeEngine.stop();
    }
  });

  it("carries session and identity validation into a delayed Hide action", async () => {
    const a = buildHandle("a", { top: 0, height: 120 });
    const adapter = new FakeAdapter([a]);
    let guard!: () => boolean;
    let finish!: (result: ActionResult) => void;
    vi.spyOn(adapter, "notInterested").mockImplementation((_handle, isCurrent?: () => boolean) => {
      guard = isCurrent!;
      return new Promise((resolve) => { finish = resolve; });
    });
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    const action = activeEngine.runAction("notInterested", true);
    await settleFocus();
    expect(guard()).toBe(true);
    await activeEngine.pause("details");
    expect(guard()).toBe(false);
    finish({ ok: false });
    await action;
    expect(activeEngine.getViewState()?.snapshot.stats.actions.notInterested).toBe(0);
  });

  it("keeps duplicate cards navigable while counting their progress once", async () => {
    const a = buildHandle("same", { top: 0, height: 120 });
    const duplicate = buildHandle("same", { top: 150, height: 120 });
    const b = buildHandle("b", { top: 300, height: 120 });
    const adapter = new FakeAdapter([a, duplicate, b]);
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    await activeEngine.next();
    expect(activeEngine.getViewState()?.focusedHandle?.element).toBe(duplicate.element);
    await activeEngine.next();
    expect(activeEngine.getFocusedPostId()).toBe("b");
    expect(activeEngine.getViewState()?.snapshot.stats.viewedCount).toBe(2);
  });

  it("acknowledges recovered presentation after exposing it without reserving another allowance", async () => {
    const b = buildHandle("b", { top: 0, height: 120 });
    const adapter = new FakeAdapter([b]);
    dailyStore.limits = { global: { maxPosts: 1 }, perSite: {} };
    dailyStore.usage = { ...buildDailyUsage(), global: { postsViewed: 1 }, perSite: { x: { postsViewed: 1 } } };
    const snapshot: SessionSnapshot = {
      sessionId: "recoverable", phase: "active", adapterId: "x", config: DEFAULT_CONFIG,
      startedAt: 1, updatedAt: 2, focusedPostId: "missing", pauseReason: null,
      pendingPresentations: [{ progressKey: "b", postId: "b" }],
      stats: { viewedCount: 1, viewedPostIds: ["b"], actions: { bookmarked: 0, notInterested: 0, openedDetails: 0 } }
    };
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), dailyStore.limits, dailyStore.usage);
    const shown = vi.fn((view) => {
      if (view.focusedHandle) expect(acknowledgeDailyView).not.toHaveBeenCalled();
    });
    // Observe the first presentation only; later phase changes occur after acknowledgment.
    const unsubscribe = activeEngine.subscribe((view) => { shown(view); if (view.focusedHandle) unsubscribe(); });
    await activeEngine.start(DEFAULT_CONFIG, snapshot);
    expect(shown).toHaveBeenCalled();
    expect(activeEngine.getFocusedPostId()).toBe("b");
    expect(reserveDailyView).not.toHaveBeenCalled();
    expect(commitDailyView).not.toHaveBeenCalled();
    expect(acknowledgeDailyView).toHaveBeenCalledWith(expect.objectContaining({ progressKey: "b" }));
    expect(dailyStore.usage.global.postsViewed).toBe(1);
  });

  it("keeps an absent unacknowledged final post recoverable without charging a replacement", async () => {
    const adapter = new FakeAdapter([buildHandle("replacement", { top: 0, height: 120 })]);
    const snapshot: SessionSnapshot = {
      sessionId: "recoverable", phase: "active", adapterId: "x", config: { ...DEFAULT_CONFIG, postLimit: 1 },
      startedAt: 1, updatedAt: 2, focusedPostId: "missing", pauseReason: null,
      pendingPresentations: [{ progressKey: "missing", postId: "missing" }],
      stats: { viewedCount: 1, viewedPostIds: ["missing"], actions: { bookmarked: 0, notInterested: 0, openedDetails: 0 } }
    };
    const onComplete = vi.fn();
    const onDailyLimitReached = vi.fn();
    activeEngine = new DeckEngine(adapter, new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage(), { onComplete, onDailyLimitReached });
    await activeEngine.start(snapshot.config, snapshot);
    expect(activeEngine.getFocusedPostId()).toBe("missing");
    expect(activeEngine.getViewState()?.focusedHandle).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onDailyLimitReached).not.toHaveBeenCalled();
    await activeEngine.resume();
    expect(await activeEngine.focusNearestToViewportCenter(true)).toBe(false);
    expect(reserveDailyView).not.toHaveBeenCalled();
    expect(acknowledgeDailyView).not.toHaveBeenCalled();
    await activeEngine.dispose();
    expect(clearOwnedSessionSnapshot).not.toHaveBeenCalled();
    expect(dailyStore.snapshot?.pendingPresentations).toEqual(snapshot.pendingPresentations);
  });

  it("retries an expired delayed commit with a fresh request and charges exactly once", async () => {
    vi.useFakeTimers();
    activeEngine = new DeckEngine(new FakeAdapter([
      buildHandle("a", { top: 0, height: 120 }), buildHandle("b", { top: 250, height: 120 })
    ]), new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    vi.mocked(reserveDailyView).mockClear(); vi.mocked(commitDailyView).mockClear();
    const requests: string[] = [];
    vi.mocked(commitDailyView).mockImplementationOnce(async (view) => {
      requests.push(view.requestId);
      await vi.advanceTimersByTimeAsync(30_001);
      return { allowed: false, denialReason: "expired", limits: dailyStore.limits, usage: dailyStore.usage };
    });
    expect(await activeEngine.next()).toBe(true);
    expect(reserveDailyView).toHaveBeenCalledTimes(2);
    expect(commitDailyView).toHaveBeenCalledTimes(2);
    expect(vi.mocked(commitDailyView).mock.calls[1][0].requestId).not.toBe(requests[0]);
    expect(activeEngine.getViewState()?.focusedHandle?.id).toBe("b");
    expect(activeEngine.getViewState()?.snapshot.stats.viewedPostIds).toEqual(["a", "b"]);
    expect(dailyStore.usage.global.postsViewed).toBe(2);
    vi.useRealTimers();
  });

  it("does not retry again if the refreshed commit expires after cancellation", async () => {
    activeEngine = new DeckEngine(new FakeAdapter([
      buildHandle("a", { top: 0, height: 120 }), buildHandle("b", { top: 250, height: 120 })
    ]), new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage());
    await activeEngine.start(DEFAULT_CONFIG);
    vi.mocked(reserveDailyView).mockClear(); vi.mocked(commitDailyView).mockClear();
    let respond!: (result: Awaited<ReturnType<typeof commitDailyView>>) => void;
    vi.mocked(commitDailyView)
      .mockResolvedValueOnce({ allowed: false, denialReason: "expired", limits: dailyStore.limits, usage: dailyStore.usage })
      .mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const advancing = activeEngine.next();
    await settleFocus();
    expect(commitDailyView).toHaveBeenCalledTimes(2);
    await activeEngine.pause("manual");
    respond({ allowed: false, denialReason: "expired", limits: dailyStore.limits, usage: dailyStore.usage });
    expect(await advancing).toBe(false);
    expect(reserveDailyView).toHaveBeenCalledTimes(2);
    expect(activeEngine.getPhase()).toBe("paused");
    expect(activeEngine.getViewState()?.focusedHandle?.id).toBe("a");
    expect(dailyStore.usage.global.postsViewed).toBe(1);
  });

  it("pauses and disposes cleanly if ownership is lost during an in-flight commit", async () => {
    let available = true;
    const onError = vi.fn();
    const reconcileOwnership = vi.fn(async () => available ? structuredClone(dailyStore.snapshot) : null);
    activeEngine = new DeckEngine(new FakeAdapter([
      buildHandle("a", { top: 0, height: 120 }), buildHandle("b", { top: 250, height: 120 })
    ]), new ActionDispatcher(0), DEFAULT_DAILY_LIMITS, buildDailyUsage(), { reconcileOwnership, onError });
    await activeEngine.start(DEFAULT_CONFIG);
    reconcileOwnership.mockClear(); vi.mocked(releaseDailyView).mockClear();
    vi.mocked(commitDailyView).mockImplementationOnce(async () => {
      available = false;
      throw new Error("Session ownership changed.");
    });
    const currentEngine = activeEngine;
    const release = vi.mocked(releaseDailyView);
    const implementation = release.getMockImplementation()!;
    release.mockRejectedValue(new Error("Session ownership changed."));
    try {
      expect(await currentEngine.next()).toBe(false);
      expect(reconcileOwnership).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("Session ownership is unavailable"));
      expect(currentEngine.getPhase()).toBe("paused");
      expect(currentEngine.getViewState()?.focusedHandle?.id).toBe("a");
      await currentEngine.dispose();
      expect(releaseDailyView).toHaveBeenCalledTimes(1);
      expect(dailyStore.usage.global.postsViewed).toBe(1);
    } finally {
      release.mockImplementation(implementation);
    }
  });

});
