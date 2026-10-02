import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUsageDelta, isDailyLimitReached, localDateKey, normalizeUsageForDate } from "@/core/daily-counter";
import { STORAGE_KEYS } from "@/shared/constants";
import type { DeckViewState } from "@/core/deck-engine";
import type { SessionSnapshot } from "@/types/session";
import type { PostHandle } from "@/types/adapter";
import type { DailyContext, DailyViewResult, RuntimeMessage } from "@/types/messages";

const state = vi.hoisted(() => ({
  items: [] as PostHandle[], following: false,
  context: { limits: { global: { maxPosts: 100 }, perSite: {} }, usage: { dateKey: "", global: { postsViewed: 0 }, perSite: {} } } as DailyContext,
  overlay: null as { prompt: boolean; daily: boolean; view: DeckViewState | null; status: string | null } | null,
  storageListener: null as ((changes: Record<string, unknown>, area: string) => void) | null,
  messageListener: null as ((message: RuntimeMessage) => Promise<unknown>) | null,
  contextRead: null as (() => Promise<DailyContext>) | null,
  viewRead: null as (() => Promise<DailyViewResult>) | null,
  snapshot: null as SessionSnapshot | null,
  clears: 0,
  scans: 0,
  claimRead: null as ((sessionId?: string) => Promise<SessionSnapshot | null>) | null,
  commitRead: null as (() => Promise<DailyViewResult>) | null,
  claims: [] as (string | undefined)[],
  reservations: [] as string[],
  dailyModalShows: 0,
  acknowledgments: [] as { progressKey: string }[],
  runtimeId: "focusdeck-test" as string | undefined,
  unmounted: 0
}));

vi.mock("@/shared/browser-polyfill", () => ({ browserApi: {
  runtime: {
    get id() { return state.runtimeId; },
    onMessage: { addListener: (listener: typeof state.messageListener) => { state.messageListener = listener; } }
  },
  storage: { onChanged: { addListener: (listener: typeof state.storageListener) => { state.storageListener = listener; } } }
} }));
vi.mock("@/shared/storage", () => ({
  getSessionConfig: async () => ({ themeMode: "system", postLimit: 20, minimalMode: true }),
  getSiteSettings: async () => ({ enabled: true, hideDistractingElements: false, bypassFollowingFeed: true })
}));
vi.mock("@/shared/runtime-state", () => ({
  getDailyContext: async () => {
    if (state.contextRead) return state.contextRead();
    state.context.usage = normalizeUsageForDate(state.context.usage, localDateKey());
    return structuredClone(state.context);
  },
  reserveDailyView: async (view: { requestId: string }) => {
    state.reservations.push(view.requestId);
    return state.viewRead ? state.viewRead() : ({ ...structuredClone(state.context), allowed: !isDailyLimitReached(state.context.limits, normalizeUsageForDate(state.context.usage, localDateKey()), "x") });
  },
  commitDailyView: async (view: { progressKey: string; postId: string }) => {
    if (state.commitRead) return state.commitRead();
    if (state.snapshot && !state.snapshot.stats.viewedPostIds.includes(view.progressKey)) {
      state.context.usage = applyUsageDelta(normalizeUsageForDate(state.context.usage, localDateKey()), "x", { postsViewed: 1 });
      state.snapshot.stats.viewedPostIds.push(view.progressKey);
      state.snapshot.stats.viewedCount = state.snapshot.stats.viewedPostIds.length;
      state.snapshot.focusedPostId = view.postId;
    }
    return { ...structuredClone(state.context), allowed: true };
  },
  releaseDailyView: async () => ({ ...structuredClone(state.context), allowed: true }),
  acknowledgeDailyView: async (view: { progressKey: string }) => {
    state.acknowledgments.push(view);
    if (state.snapshot) state.snapshot.pendingPresentations = state.snapshot.pendingPresentations?.filter((pending) => pending.progressKey !== view.progressKey);
  },
  claimSessionSnapshot: async (_siteId: string, sessionId?: string) => {
    state.claims.push(sessionId);
    return state.claimRead ? state.claimRead(sessionId) : structuredClone(state.snapshot);
  },
  saveOwnedSessionSnapshot: async (snapshot: SessionSnapshot) => { state.snapshot = structuredClone(snapshot); return snapshot; },
  clearOwnedSessionSnapshot: async () => { state.clears += 1; state.snapshot = null; }
}));
vi.mock("@/adapters/x-adapter", () => ({ XAdapter: class {
  id = "x";
  name = "X";
  isSupportedUrl = () => true;
  isFeedPage = (url: string) => new URL(url).pathname === "/home";
  isDetailPage = (url: string) => url.includes("/status/");
  getFeedItems = () => { state.scans += 1; return state.items; };
  getProgressKey = (handle: PostHandle) => handle.id;
  getHandleId = (element: HTMLElement) => state.items.find((item) => item.element === element)?.id ?? null;
  getPostMeta = () => null;
  focusItem = () => undefined;
} }));
vi.mock("@/content/following-bypass", () => ({
  isFollowingBypassActive: (_settings: unknown, feed: boolean) => feed && state.following,
  shouldPauseFollowingBypass: (phase: string) => phase === "active",
  shouldResumeFromFollowingBypass: (phase: string, reason: string) => phase === "paused" && reason === "followingBypass",
  shouldSuppressFollowingLimitUi: (bypass: boolean) => bypass
}));
vi.mock("@/content/overlay/overlay", () => ({ OverlayController: class {
  prompt = false;
  daily = false;
  status: string | null = null;
  view: DeckViewState | null = null;
  constructor(private callbacks: { onBlockingModalVisibilityChange: (visible: boolean) => void }) { state.overlay = this; }
  mount() {}
  unmount() { state.unmounted += 1; this.callbacks.onBlockingModalVisibilityChange(false); }
  setView(view: DeckViewState | null) { this.view = view; }
  setPromptVisible(visible: boolean) { this.prompt = visible; this.syncBlocking(); }
  setDailyLimitReached(visible: boolean) { if (visible) state.dailyModalShows += 1; this.daily = visible; this.syncBlocking(); }
  isPromptOrDailyLimitVisible() { return this.prompt || this.daily; }
  syncBlocking() { this.callbacks.onBlockingModalVisibilityChange(this.prompt || this.daily); }
  setThemeMode() {}
  setStatus(message: string | null) { this.status = message; }
  setPromptPostLimitCap() {}
  setDailyLimitContext() {}
} }));

class FixtureElement {
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  media: FixtureElement | null = null;
  id = "";
  tagName = "ARTICLE";
  scrollHeight = 1000;
  clientHeight = 600;
  scrollTop = 0;
  isConnected = true;
  isContentEditable = false;
  parentElement: FixtureElement | null = null;
  classList = { contains: () => false };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  remove() { this.isConnected = false; }
  top = 0;
  height = 120;
  getBoundingClientRect() { return { top: this.top, bottom: this.top + this.height, left: 0, height: this.height }; }
  matches(selector: string) { return (this.tagName === "ARTICLE" && selector.includes("article")) ||
    (this.tagName === "VIDEO" && selector.includes("video")) || (this.getAttribute("role") === "tab" && selector.includes("[role='tab']")); }
  closest(selector: string): FixtureElement | null {
    let element: FixtureElement | null = this;
    while (element) {
      if (element.matches(selector)) return element;
      element = element.parentElement;
    }
    return null;
  }
  contains(node: unknown) { return node === this || node === this.media; }
  querySelector(selector: string) { return selector === "video" ? this.media : null; }
  querySelectorAll(selector: string) { return selector === "video" && this.media ? [this.media] : []; }
  addEventListener() {}
  removeEventListener() {}
}
class FixtureMedia extends FixtureElement {
  tagName = "VIDEO";
  preload = "metadata";
  playsInline = false;
  ended = false;
}
class FixtureObserver {
  static instances: FixtureObserver[] = [];
  target: unknown;
  options: MutationObserverInit | null = null;
  constructor(readonly callback: (records: MutationRecord[]) => void) { FixtureObserver.instances.push(this); }
  observe(target: unknown, options: MutationObserverInit) { this.target = target; this.options = options; }
  disconnect() {}
}

let doc: { documentElement: FixtureElement; visibilityState: string };
let events: Map<string, ((event: unknown) => void)[]>;
let location: { href: string };

function handle(id: string): PostHandle {
  return { id, element: new FixtureElement() as unknown as HTMLElement };
}
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
}
async function navigate(url: string): Promise<void> {
  location.href = url;
  history.pushState(null, "", url);
  await settle();
}
function mutation(target: HTMLElement, type = "attributes") {
  FixtureObserver.instances[0].callback([{ type, target, addedNodes: [target], removedNodes: [] } as unknown as MutationRecord]);
}
async function start(postLimit = 20): Promise<void> {
  await state.messageListener!({ type: "focusdeck:start-session", payload: { postLimit } });
  await settle();
}


function nextPost(): void {
  for (const callback of events.get("keydown") ?? []) callback({ key: "j", target: null, composedPath: () => [], preventDefault() {} });
}

describe("content runtime gating and route reconciliation", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    events = new Map();
    state.items = [handle("a"), handle("b")];
    state.following = false;
    state.context = { limits: { global: { maxPosts: 100 }, perSite: {} }, usage: { dateKey: localDateKey(), global: { postsViewed: 0 }, perSite: {} } };
    state.contextRead = null;
    state.viewRead = null;
    state.snapshot = null;
    state.clears = 0;
    state.scans = 0;
    state.runtimeId = "focusdeck-test";
    state.unmounted = 0;
    state.acknowledgments = [];
    state.dailyModalShows = 0;
    state.claimRead = null;
    state.commitRead = null;
    state.claims = [];
    state.reservations = [];
    state.overlay = null;
    FixtureObserver.instances = [];
    location = { href: "https://x.com/home" };
    const root = new FixtureElement();
    const styles: FixtureElement[] = [];
    doc = { documentElement: root, visibilityState: "visible" };
    const eventTarget = {
      addEventListener: (type: string, callback: (event: unknown) => void) => {
        events.set(type, [...events.get(type) ?? [], callback]);
      },
      removeEventListener: (type: string, callback: (event: unknown) => void) => {
        events.set(type, events.get(type)?.filter((item) => item !== callback) ?? []);
      }
    };
    vi.stubGlobal("document", {
      ...doc, ...eventTarget, body: root, scrollingElement: root,
      head: { append: (style: FixtureElement) => styles.push(style) },
      createElement: () => new FixtureElement(),
      getElementById: (id: string) => styles.find((style) => style.id === id),
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        const match = selector.match(/^\[([^=]+)='true'\]$/);
        return match ? state.items.map((item) => item.element).filter((element) => element.getAttribute(match[1]) === "true") : [];
      }
    });
    vi.stubGlobal("window", {
      ...eventTarget, location, innerHeight: 600, scrollY: 0, pageYOffset: 0,
      setTimeout, clearTimeout, setInterval, clearInterval,
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16),
      cancelAnimationFrame: clearTimeout
    });
    vi.stubGlobal("history", { pushState: () => undefined, replaceState: () => undefined });
    vi.stubGlobal("Node", FixtureElement);
    vi.stubGlobal("Element", FixtureElement);
    vi.stubGlobal("HTMLElement", FixtureElement);
    vi.stubGlobal("HTMLMediaElement", FixtureMedia);
    vi.stubGlobal("MutationObserver", FixtureObserver);
    await import("./index");
    await settle();
  });

  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("locks newly inserted idle cards and observes a stable ancestor", () => {
    expect(state.overlay?.prompt).toBe(true);
    const inserted = handle("c");
    state.items.push(inserted);
    mutation(inserted.element, "childList");
    expect(inserted.element.getAttribute("data-focusdeck-locked")).toBe("true");
    expect(FixtureObserver.instances[0].target).toBe(doc.documentElement);
    expect(FixtureObserver.instances[0].options).toMatchObject({ attributes: true, characterData: true });
  });

  it("resumes details pauses after returning through Following at the same URL", async () => {
    await start();
    await navigate("https://x.com/alice/status/123");
    expect(state.overlay?.view?.snapshot.phase).toBe("paused");
    state.following = true;
    await navigate("https://x.com/home");
    expect(state.items[0].element.hasAttribute("data-focusdeck-hidden")).toBe(false);
    state.following = false;
    mutation(state.items[0].element);
    await vi.advanceTimersByTimeAsync(20);
    await settle();
    expect(state.overlay?.view?.snapshot.phase).toBe("active");
    expect(state.items[1].element.getAttribute("data-focusdeck-hidden")).toBe("true");
    expect(state.context.usage.global.postsViewed).toBe(1);
  });

  it("keeps neighboring posts hidden through focused video interactions", async () => {
    await start();
    const focused = state.items[0].element as unknown as FixtureElement;
    focused.media = new FixtureMedia();
    const event = { target: focused.media, preventDefault() {}, stopPropagation() {} };
    for (const type of ["pointerdown", "play", "pause", "click"]) {
      for (const callback of events.get(type) ?? []) callback(event);
      await vi.advanceTimersByTimeAsync(20);
      expect(state.items[1].element.getAttribute("data-focusdeck-hidden")).toBe("true");
      expect(state.items[1].element.hasAttribute("data-focusdeck-focused")).toBe(false);
    }
  });

  it("keeps the focused post shown while its own video player mutates", async () => {
    await start();
    await vi.advanceTimersByTimeAsync(20); await settle();
    const element = state.items[0].element;
    expect(element.getAttribute("data-focusdeck-focused")).toBe("true");
    for (let i = 0; i < 5; i += 1) {
      mutation(element);
      expect(element.getAttribute("data-focusdeck-focused")).toBe("true");
      expect(element.hasAttribute("data-focusdeck-hidden")).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(16); await settle();
    expect(element.getAttribute("data-focusdeck-focused")).toBe("true");
    expect(state.items[1].element.getAttribute("data-focusdeck-hidden")).toBe("true");
    expect(state.context.usage.global.postsViewed).toBe(1);
  });

  it("keeps viewed posts playable through their own mutations after the session target", async () => {
    await start(1);
    await vi.advanceTimersByTimeAsync(20); await settle();
    const element = state.items[0].element;
    expect(element.hasAttribute("data-focusdeck-post-limit-blocked")).toBe(false);
    mutation(element);
    expect(element.hasAttribute("data-focusdeck-post-limit-blocked")).toBe(false);
    expect((element as HTMLElement & { inert: boolean }).inert).toBe(false);
    expect(state.items[1].element.getAttribute("data-focusdeck-post-limit-blocked")).toBe("true");
  });

  it("removes all gating once the extension context is invalidated", async () => {
    await start();
    await vi.advanceTimersByTimeAsync(20); await settle();
    const [focused, neighbor] = state.items.map((item) => item.element);
    expect(neighbor.getAttribute("data-focusdeck-hidden")).toBe("true");

    state.runtimeId = undefined;
    await vi.advanceTimersByTimeAsync(250); await settle();
    expect(focused.hasAttribute("data-focusdeck-focused")).toBe(false);
    expect(neighbor.hasAttribute("data-focusdeck-hidden")).toBe(false);
    expect(state.unmounted).toBe(1);

    mutation(neighbor);
    await vi.advanceTimersByTimeAsync(20); await settle();
    expect(neighbor.hasAttribute("data-focusdeck-hidden")).toBe(false);
    expect(neighbor.hasAttribute("data-focusdeck-locked")).toBe(false);
  });

  it("hides blocking modals and unlocks scroll when leaving a daily-blocked feed", async () => {
    state.context.limits.global.maxPosts = 1;
    await start();
    expect(state.overlay?.daily).toBe(true);
    await navigate("https://x.com/alice");
    expect(state.overlay?.daily).toBe(false);
    expect(state.overlay?.prompt).toBe(false);
    expect(doc.documentElement.style.overflow).not.toBe("hidden");
  });

  it("preserves daily blocking when the session target is reached at the same time", async () => {
    state.context.limits.global.maxPosts = 1;
    await start(1);
    expect(state.overlay?.daily).toBe(true);
    expect((state.items[1].element as HTMLElement & { inert: boolean }).inert).toBe(true);
  });

  it("propagates changed limits and usage resets to active tabs", async () => {
    await start();
    state.context.limits.global.maxPosts = 1;
    state.storageListener!({ [STORAGE_KEYS.dailyLimits]: {} }, "local");
    await settle();
    expect(state.overlay?.daily).toBe(true);
    state.context.usage = { dateKey: localDateKey(), global: { postsViewed: 0 }, perSite: {} };
    state.storageListener!({ [STORAGE_KEYS.dailyUsage]: {} }, "local");
    await settle();
    expect(state.overlay?.daily).toBe(false);
    expect(state.overlay?.view?.snapshot.phase).toBe("active");
  });

  it("cancels the shared start retry when stopped during feed loading", async () => {
    state.items = [];
    const first = state.messageListener!({ type: "focusdeck:start-session" });
    const second = state.messageListener!({ type: "focusdeck:start-session" });
    await settle();
    await state.messageListener!({ type: "focusdeck:stop-session" });
    await vi.advanceTimersByTimeAsync(150);
    expect(await first).toEqual({ ok: false, data: { started: false } });
    expect(await second).toEqual({ ok: false, data: { started: false } });
    expect(state.overlay?.view).toBeNull();
  });

  it("immediately reconciles cards recycled to an unseen identity", async () => {
    await start();
    const element = state.items[0].element;
    state.items[0] = { id: "c", element };
    mutation(element);
    expect(element.getAttribute("data-focusdeck-hidden")).toBe("true");
    await vi.advanceTimersByTimeAsync(20);
    await settle();
    expect(state.overlay?.view?.snapshot.stats.viewedPostIds).toEqual(["a", "c"]);
    expect(state.context.usage.global.postsViewed).toBe(2);
  });
  it("ignores stale prompt reads after navigation away from the feed", async () => {
    await navigate("https://x.com/alice");
    let release!: (context: DailyContext) => void;
    state.contextRead = () => new Promise((resolve) => { release = resolve; });
    location.href = "https://x.com/home";
    history.pushState(null, "", location.href);
    await settle();
    await navigate("https://x.com/bob");
    state.contextRead = null;
    release(structuredClone(state.context));
    await settle();
    expect(state.overlay?.prompt).toBe(false);
    expect(state.overlay?.daily).toBe(false);
    expect(doc.documentElement.style.overflow).not.toBe("hidden");
  });

  it("shares concurrent starts without resetting a newly loaded session", async () => {
    state.items = [];
    const first = state.messageListener!({ type: "focusdeck:start-session", payload: { postLimit: 10 } });
    const second = state.messageListener!({ type: "focusdeck:start-session", payload: { postLimit: 30 } });
    await settle();
    state.items = [handle("a"), handle("b")];
    await vi.advanceTimersByTimeAsync(150);
    expect(await first).toEqual({ ok: true, data: { started: true } });
    expect(await second).toEqual({ ok: true, data: { started: true } });
    expect(state.overlay?.view?.snapshot.config.postLimit).toBe(10);
    expect(state.context.usage.global.postsViewed).toBe(1);
  });

  it("reconciles inertness when completed-session cards are recycled", async () => {
    await start(1);
    const element = state.items[0].element;
    state.items[0] = { id: "c", element };
    mutation(element);
    expect((element as HTMLElement & { inert: boolean }).inert).toBe(true);
    state.items[0] = { id: "a", element };
    mutation(element);
    await vi.advanceTimersByTimeAsync(16);
    expect((element as HTMLElement & { inert: boolean }).inert).toBe(false);
  });

  it("refreshes a midnight-blocked session on tab activation", async () => {
    await start();
    state.context.limits.global.maxPosts = 1;
    state.storageListener!({ [STORAGE_KEYS.dailyLimits]: {} }, "local");
    await settle();
    expect(state.overlay?.daily).toBe(true);
    const nextDay = new Date();
    nextDay.setDate(nextDay.getDate() + 1);
    vi.setSystemTime(nextDay);
    for (const callback of events.get("visibilitychange") ?? []) callback({});
    await settle();
    expect(state.overlay?.daily).toBe(false);
    expect(state.overlay?.view?.snapshot.phase).toBe("active");
    expect(state.context.usage.global.postsViewed).toBe(0);
  });

  it.each([true, false])("keeps initial cards locked while a pending view resolves (allowed=%s)", async (allowed) => {
    let release!: (result: DailyViewResult) => void;
    state.viewRead = () => new Promise((resolve) => { release = resolve; });
    const starting = state.messageListener!({ type: "focusdeck:start-session" });
    await settle();
    state.storageListener!({ [STORAGE_KEYS.dailyUsage]: {} }, "local");
    await settle();
    expect(state.items.every((item) => item.element.getAttribute("data-focusdeck-locked") === "true")).toBe(true);
    const usage = { dateKey: localDateKey(), global: { postsViewed: 100 }, perSite: {} };
    state.viewRead = null;
    if (!allowed) {
      state.context.usage = usage;
      state.storageListener!({ [STORAGE_KEYS.dailyUsage]: {} }, "local");
      await settle();
    }
    release({ limits: state.context.limits, usage, allowed });
    await starting; await settle();
    if (!allowed) {
      expect(state.items.every((item) => item.element.getAttribute("data-focusdeck-locked") === "true")).toBe(true);
      expect(state.overlay?.view?.snapshot.focusedPostId).toBeNull();
      expect(state.overlay?.daily).toBe(true);
    }
  });

  it("preserves an interrupted resume when its replacement request resolves after navigation", async () => {
    await navigate("https://x.com/alice/status/10");
    state.snapshot = {
      sessionId: "recoverable", adapterId: "x", phase: "paused", pauseReason: "details", focusedPostId: "missing",
      config: { themeMode: "system", postLimit: 20, minimalMode: true }, startedAt: 1, updatedAt: 2,
      stats: { viewedPostIds: ["missing"], viewedCount: 1, actions: { bookmarked: 0, notInterested: 0, openedDetails: 0 } }
    };
    let release!: (result: DailyViewResult) => void;
    state.viewRead = () => new Promise((resolve) => { release = resolve; });
    await navigate("https://x.com/home");
    expect(state.snapshot.stats.viewedPostIds).toEqual(["missing"]);
    await navigate("https://x.com/alice/status/11");
    state.viewRead = null;
    release({ ...structuredClone(state.context), allowed: true });
    await settle();
    expect(state.clears).toBe(0);
    expect(state.snapshot?.sessionId).toBe("recoverable");
    expect(state.snapshot?.stats.viewedPostIds).toEqual(["missing"]);
    expect(state.context.usage.global.postsViewed).toBe(0);
    await navigate("https://x.com/home");
    expect(state.overlay?.view?.snapshot.stats.viewedPostIds).toEqual(["missing", "a"]);
    expect(state.context.usage.global.postsViewed).toBe(1);
  });

  it.each(["reset", "midnight", "limit edit"] as const)("rechecks allowance on Following return after %s", async (change) => {
    await start();
    state.context.limits.global.maxPosts = 1;
    state.storageListener!({ [STORAGE_KEYS.dailyLimits]: {} }, "local");
    await settle();
    expect(state.overlay?.daily).toBe(true);
    state.following = true;
    mutation(state.items[0].element);
    await vi.advanceTimersByTimeAsync(16);
    expect(state.overlay?.daily).toBe(false);
    if (change === "reset") {
      state.context.usage = { dateKey: localDateKey(), global: { postsViewed: 0 }, perSite: {} };
      state.storageListener!({ [STORAGE_KEYS.dailyUsage]: {} }, "local");
    } else if (change === "midnight") {
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      vi.setSystemTime(tomorrow);
      for (const callback of events.get("visibilitychange") ?? []) callback({});
    } else {
      state.context.limits.global.maxPosts = 10;
      state.storageListener!({ [STORAGE_KEYS.dailyLimits]: {} }, "local");
    }
    await settle();
    state.following = false;
    mutation(state.items[0].element);
    await vi.advanceTimersByTimeAsync(16); await settle();
    expect(state.overlay?.daily).toBe(false);
    expect(state.overlay?.view?.snapshot.phase).toBe("active");
    expect(state.items[1].element.getAttribute("data-focusdeck-hidden")).toBe("true");
    expect(state.context.usage.global.postsViewed).toBe(change === "limit edit" ? 1 : 0);
  });

  it("coalesces repeated mutations without synchronous feed scans and immediately gates reused cards", async () => {
    await start();
    await vi.advanceTimersByTimeAsync(20);
    state.scans = 0;
    const element = state.items[0].element;
    state.items[0] = { id: "c", element };
    for (let i = 0; i < 10; i += 1) mutation(element);
    expect(state.scans).toBe(0);
    expect(element.getAttribute("data-focusdeck-hidden")).toBe("true");
    await vi.advanceTimersByTimeAsync(16); await settle();
    expect(state.context.usage.global.postsViewed).toBe(2);
    const coalescedScans = state.scans;
    state.scans = 0;
    mutation(element);
    await vi.advanceTimersByTimeAsync(16); await settle();
    expect(state.scans).toBe(1);
    expect(coalescedScans).toBeGreaterThan(1);
    expect(state.context.usage.global.postsViewed).toBe(2);
  });

  it("gates a tab-only managed-feed return synchronously while fresh allowance is pending", async () => {
    await start();
    const tab = new FixtureElement(); tab.tagName = "DIV"; tab.setAttribute("role", "tab");
    state.following = true;
    mutation(tab as unknown as HTMLElement);
    await vi.advanceTimersByTimeAsync(16); await settle();
    let release!: (context: DailyContext) => void;
    state.contextRead = () => new Promise((resolve) => { release = resolve; });
    state.context.limits.global.maxPosts = 1;
    state.following = false;
    mutation(tab as unknown as HTMLElement);
    expect(state.items.every((item) => item.element.getAttribute("data-focusdeck-locked") === "true")).toBe(true);
    await vi.advanceTimersByTimeAsync(16); await settle();
    expect(state.items.every((item) => item.element.getAttribute("data-focusdeck-locked") === "true")).toBe(true);
    state.contextRead = null;
    release(structuredClone(state.context));
    await settle();
    expect(state.overlay?.daily).toBe(true);
    expect(state.context.usage.global.postsViewed).toBe(1);
  });

  it("shows the session prompt when switching from Following to For You without a session", async () => {
    const tab = new FixtureElement(); tab.tagName = "DIV"; tab.setAttribute("role", "tab");
    state.following = true;
    mutation(tab as unknown as HTMLElement);
    await vi.advanceTimersByTimeAsync(16); await settle();
    expect(state.overlay?.prompt).toBe(false);
    expect(state.items.some((item) => item.element.hasAttribute("data-focusdeck-locked"))).toBe(false);
    state.following = false;
    mutation(tab as unknown as HTMLElement);
    await vi.advanceTimersByTimeAsync(16); await settle();
    expect(state.overlay?.prompt).toBe(true);
    expect(state.items.every((item) => item.element.getAttribute("data-focusdeck-locked") === "true")).toBe(true);
    await start();
    expect(state.overlay?.view?.snapshot.phase).toBe("active");
  });

  it("shows the daily-limit dialog when switching from Following to For You at the limit", async () => {
    const tab = new FixtureElement(); tab.tagName = "DIV"; tab.setAttribute("role", "tab");
    state.following = true;
    mutation(tab as unknown as HTMLElement);
    await vi.advanceTimersByTimeAsync(16); await settle();
    state.context.usage.global.postsViewed = 100;
    state.following = false;
    mutation(tab as unknown as HTMLElement);
    await vi.advanceTimersByTimeAsync(16); await settle();
    expect(state.overlay?.daily).toBe(true);
    expect(state.overlay?.prompt).toBe(false);
    expect(state.items.every((item) => item.element.getAttribute("data-focusdeck-locked") === "true")).toBe(true);
  });

  it("uses exactly one feed pass for multiple same-frame card updates", async () => {
    await start(); await vi.advanceTimersByTimeAsync(20);
    state.scans = 0;
    for (let i = 0; i < 10; i += 1) mutation(state.items[0].element);
    expect(state.scans).toBe(0);
    await vi.advanceTimersByTimeAsync(16); await settle();
    expect(state.scans).toBe(1);
    expect(state.context.usage.global.postsViewed).toBe(1);
  });

  it("serializes reconciliation when a card is recycled again during a pending request", async () => {
    await start(); await vi.advanceTimersByTimeAsync(20);
    const element = state.items[0].element;
    let release!: (result: DailyViewResult) => void;
    state.viewRead = () => new Promise((resolve) => { release = resolve; });
    state.items[0] = { id: "c", element };
    mutation(element);
    await vi.advanceTimersByTimeAsync(16); await settle();
    state.items[0] = { id: "d", element };
    mutation(element);
    expect(element.getAttribute("data-focusdeck-hidden")).toBe("true");
    state.viewRead = null;
    release({ ...structuredClone(state.context), allowed: true });
    await settle();
    expect(state.context.usage.global.postsViewed).toBe(1);
    expect(element.getAttribute("data-focusdeck-hidden")).toBe("true");
    await vi.advanceTimersByTimeAsync(16); await settle();
    expect(state.overlay?.view?.snapshot.stats.viewedPostIds).toEqual(["a", "d"]);
    expect(state.context.usage.global.postsViewed).toBe(2);
  });

  it.each(["prepend", "expansion"] as const)("recovers a connected focus moved outside the viewport by %s", async (cause) => {
    await start(); await vi.advanceTimersByTimeAsync(20);
    const original = state.items[0].element as unknown as FixtureElement;
    const visible = state.items[1].element;
    original.top = cause === "prepend" ? 800 : -300;
    if (cause === "prepend") {
      const inserted = handle("inserted");
      (inserted.element as unknown as FixtureElement).top = -200;
      state.items.unshift(inserted);
      mutation(inserted.element, "childList");
    } else mutation(original as unknown as HTMLElement, "childList");
    expect(original.isConnected).toBe(true);
    expect(visible.getAttribute("data-focusdeck-hidden")).toBe("true");
    await vi.advanceTimersByTimeAsync(16); await settle();
    expect(state.overlay?.view?.snapshot.focusedPostId).toBe("b");
    expect(visible.getAttribute("data-focusdeck-focused")).toBe("true");
    expect(original.getAttribute("data-focusdeck-hidden")).toBe("true");
    expect(state.overlay?.view?.snapshot.stats.viewedPostIds).toEqual(["a", "b"]);
    expect(state.context.usage.global.postsViewed).toBe(2);
  });

  it.each([20, 1])("presents and acknowledges recovered charged progress at both caps (target=%s)", async (postLimit) => {
    await navigate("https://x.com/alice/status/10");
    state.snapshot = {
      sessionId: "recoverable", adapterId: "x", phase: "active", pauseReason: null, focusedPostId: "b",
      config: { themeMode: "system", postLimit, minimalMode: true }, startedAt: 1, updatedAt: 2,
      pendingPresentations: [{ progressKey: "b", postId: "b" }],
      stats: { viewedPostIds: ["b"], viewedCount: 1, actions: { bookmarked: 0, notInterested: 0, openedDetails: 0 } }
    };
    state.context.limits.global.maxPosts = 1;
    state.context.usage.global.postsViewed = 1;
    await navigate("https://x.com/home");
    await settle();
    expect(state.context.usage.global.postsViewed).toBe(1);
    expect(state.acknowledgments.map((view) => view.progressKey)).toEqual(["b"]);
    expect(state.overlay?.daily).toBe(false);
    state.storageListener!({ [STORAGE_KEYS.dailyUsage]: {} }, "local");
    await settle();
    expect(state.overlay?.daily).toBe(false);
    expect(state.context.usage.global.postsViewed).toBe(1);
    const recovered = state.items[1].element;
    const media = new FixtureMedia();
    (recovered as unknown as FixtureElement).media = media;
    media.parentElement = recovered as unknown as FixtureElement;
    state.dailyModalShows = 0;
    state.scans = 0;
    mutation(media as unknown as HTMLElement);
    expect(recovered.hasAttribute("data-focusdeck-hidden")).toBe(false);
    await vi.advanceTimersByTimeAsync(16); await settle();
    expect(state.scans).toBeGreaterThan(0);
    expect(state.dailyModalShows).toBe(0);
    expect(state.acknowledgments.map((view) => view.progressKey)).toEqual(["b"]);
    expect(state.context.usage.global.postsViewed).toBe(1);
    if (postLimit > 1) {
      expect(recovered.getAttribute("data-focusdeck-focused")).toBe("true");
      expect(state.overlay?.view?.snapshot.focusedPostId).toBe("b");
    } else expect((recovered as HTMLElement & { inert: boolean }).inert).toBe(false);
    expect(state.items[0].element.hasAttribute("data-focusdeck-focused")).toBe(false);
    await state.messageListener!({ type: "focusdeck:stop-session" });
    await settle();
    expect(state.overlay?.daily).toBe(true);
    expect(state.context.usage.global.postsViewed).toBe(1);
  });

  it("waits for bfcache ownership reconciliation before allowing progression", async () => {
    await start();
    const sessionId = state.snapshot!.sessionId;
    let reclaim!: (snapshot: SessionSnapshot | null) => void;
    state.claimRead = async (expected) => {
      expect(expected).toBe(sessionId);
      return new Promise((resolve) => { reclaim = resolve; });
    };
    state.claims = [];
    for (const callback of events.get("pageshow") ?? []) callback({ persisted: true });
    await settle();
    expect(state.claims).toEqual([sessionId]);
    nextPost(); await settle();
    expect(state.context.usage.global.postsViewed).toBe(1);
    expect(state.items[1].element.hasAttribute("data-focusdeck-focused")).toBe(false);
    state.claimRead = null;
    reclaim(structuredClone(state.snapshot));
    await settle();
    expect(state.context.usage.global.postsViewed).toBe(2);
    expect(state.items[1].element.getAttribute("data-focusdeck-focused")).toBe("true");
  });

  it("reclaims and reconciles after cancelled navigation without a pageshow event", async () => {
    await start();
    const sessionId = state.snapshot!.sessionId;
    state.snapshot!.stats.viewedPostIds.push("b");
    state.snapshot!.stats.viewedCount = 2;
    state.context.usage.global.postsViewed = 2;
    state.claims = [];
    nextPost(); await settle();
    expect(state.claims).toEqual([sessionId]);
    expect(state.overlay?.view?.snapshot.stats.viewedPostIds).toEqual(["a", "b"]);
    expect(state.context.usage.global.postsViewed).toBe(2);
    expect(state.items[1].element.getAttribute("data-focusdeck-focused")).toBe("true");
  });

  it.each(["pageshow", "progression"] as const)("pauses visibly when surviving-document ownership cannot be reclaimed on %s", async (trigger) => {
    await start();
    state.claimRead = async () => null;
    if (trigger === "pageshow") for (const callback of events.get("pageshow") ?? []) callback({ persisted: true });
    else nextPost();
    await settle();
    expect(state.overlay?.view?.snapshot.phase).toBe("paused");
    expect(state.overlay?.status).toContain("Session ownership is unavailable");
    expect(state.items[0].element.getAttribute("data-focusdeck-focused")).toBe("true");
    expect(state.items[1].element.getAttribute("data-focusdeck-hidden")).toBe("true");
    expect(state.context.usage.global.postsViewed).toBe(1);
    expect(state.reservations).toHaveLength(1);
  });

  it("retries a legitimately delayed startup commit without leaving a blank locked feed", async () => {
    (state.items[1].element as unknown as FixtureElement).top = 250;
    doc.documentElement.scrollTop = 300;
    state.commitRead = async () => {
      await vi.advanceTimersByTimeAsync(30_001);
      state.commitRead = null;
      return { ...structuredClone(state.context), allowed: false, denialReason: "expired" };
    };
    await start();
    expect(state.reservations).toHaveLength(2);
    expect(state.reservations[1]).not.toBe(state.reservations[0]);
    expect(state.overlay?.view?.snapshot.phase).toBe("active");
    expect(state.items[0].element.getAttribute("data-focusdeck-focused")).toBe("true");
    expect(state.items[0].element.hasAttribute("data-focusdeck-locked")).toBe(false);
    expect(state.overlay?.prompt).toBe(false);
    expect(state.context.usage.global.postsViewed).toBe(1);
  });

  it("shows an explicit retry prompt when startup reservations repeatedly expire", async () => {
    state.commitRead = async () => ({ ...structuredClone(state.context), allowed: false, denialReason: "expired" });
    await start();
    expect(state.reservations).toHaveLength(2);
    expect(state.overlay?.view?.snapshot.phase).toBe("paused");
    expect(state.overlay?.prompt).toBe(true);
    expect(state.overlay?.status).toContain("Start the session again to retry");
    expect(state.items.every((item) => item.element.getAttribute("data-focusdeck-locked") === "true")).toBe(true);
    expect(state.context.usage.global.postsViewed).toBe(0);
    state.commitRead = null;
    await start();
    expect(state.overlay?.prompt).toBe(false);
    expect(state.items[0].element.getAttribute("data-focusdeck-focused")).toBe("true");
    expect(state.context.usage.global.postsViewed).toBe(1);
  });

  it("reclaims ownership if an in-flight commit resumes after navigation invalidated it", async () => {
    await start();
    let fail!: (error: Error) => void;
    state.commitRead = () => new Promise((_resolve, reject) => { fail = reject; });
    nextPost(); await settle();
    const sessionId = state.snapshot!.sessionId;
    state.claims = [];
    state.commitRead = null;
    fail(new Error("Session ownership changed."));
    await settle();
    expect(state.claims).toEqual([sessionId, sessionId]);
    expect(state.overlay?.view?.snapshot.phase).toBe("active");
    expect(state.items[1].element.getAttribute("data-focusdeck-focused")).toBe("true");
    expect(state.overlay?.status).not.toBe("Session ownership changed.");
    expect(state.context.usage.global.postsViewed).toBe(2);
  });

});
