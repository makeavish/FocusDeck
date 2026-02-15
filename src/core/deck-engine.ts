import { applyUsageDelta, isDailyLimitReached } from "@/core/daily-counter";
import { transitionSessionPhase } from "@/core/session-state";
import { clearSessionSnapshot, setDailyUsage, setSessionSnapshot } from "@/shared/storage";
import type { ActionResult, Adapter, AdapterAction, PostHandle, PostMeta } from "@/types/adapter";
import type {
  DailyLimitsConfig,
  DailyUsage,
  PauseReason,
  SessionConfig,
  SessionSnapshot,
  SessionStats,
  SessionSummary
} from "@/types/session";
import { ActionDispatcher } from "./action-dispatcher";

export interface DeckViewState {
  snapshot: SessionSnapshot;
  focusedHandle: PostHandle | null;
  focusedMeta: PostMeta | null;
  feedCount: number;
}

interface RuntimeState {
  snapshot: SessionSnapshot;
  viewedIdSet: Set<string>;
}

interface EngineCallbacks {
  onComplete?: (summary: SessionSummary) => void;
  onDailyLimitReached?: () => void;
  onDailyUsageUpdated?: (usage: DailyUsage) => void;
  canCountProgress?: () => boolean;
  canCountTime?: () => boolean;
}

type StateListener = (state: DeckViewState) => void;

const EMPTY_STATS: SessionStats = {
  viewedCount: 0,
  viewedPostIds: [],
  activeMs: 0,
  actions: {
    notInterested: 0,
    bookmarked: 0,
    openedDetails: 0
  }
};

export class DeckEngine {
  private state: RuntimeState | null = null;
  private dailyUsage: DailyUsage;
  private dailyLimits: DailyLimitsConfig;
  private focusedHandle: PostHandle | null = null;
  private readonly listeners = new Set<StateListener>();
  private observerCleanup: (() => void) | null = null;
  private timerId: number | null = null;
  private scrollRafId = 0;
  private persistTimerId: number | null = null;
  private lastTickAt = 0;
  private routePauseReason: PauseReason = null;

  constructor(
    private readonly adapter: Adapter,
    private readonly dispatcher: ActionDispatcher,
    dailyLimits: DailyLimitsConfig,
    dailyUsage: DailyUsage,
    private readonly callbacks: EngineCallbacks = {}
  ) {
    this.dailyLimits = dailyLimits;
    this.dailyUsage = dailyUsage;
  }

  setDailyContext(limits: DailyLimitsConfig, usage: DailyUsage): void {
    this.dailyLimits = limits;
    this.dailyUsage = usage;
  }

  getDailyUsage(): DailyUsage {
    return this.dailyUsage;
  }

  getPhase(): SessionSnapshot["phase"] {
    return this.state?.snapshot.phase ?? "idle";
  }

  getFocusedPostId(): string | null {
    return this.state?.snapshot.focusedPostId ?? null;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    const state = this.getViewState();
    if (state) {
      listener(state);
    }
    return () => this.listeners.delete(listener);
  }

  async start(config: SessionConfig, snapshot?: SessionSnapshot | null): Promise<boolean> {
    const feedItems = this.adapter.getFeedItems();
    if (!feedItems.length) {
      return false;
    }

    const resumed = Boolean(snapshot && snapshot.adapterId === this.adapter.id);
    const stats = resumed && snapshot ? { ...snapshot.stats } : { ...EMPTY_STATS };
    const viewedSet = new Set(stats.viewedPostIds);
    const nextSnapshot: SessionSnapshot = {
      phase: "active",
      adapterId: this.adapter.id,
      config: { ...config },
      startedAt: resumed && snapshot ? snapshot.startedAt : Date.now(),
      updatedAt: Date.now(),
      focusedPostId: resumed && snapshot ? snapshot.focusedPostId : null,
      pauseReason: null,
      stats: {
        viewedCount: viewedSet.size,
        viewedPostIds: [...viewedSet],
        activeMs: Math.max(0, Math.floor(stats.activeMs)),
        actions: {
          notInterested: stats.actions.notInterested || 0,
          bookmarked: stats.actions.bookmarked || 0,
          openedDetails: stats.actions.openedDetails || 0
        }
      }
    };

    this.state = {
      snapshot: nextSnapshot,
      viewedIdSet: viewedSet
    };

    this.lastTickAt = Date.now();
    this.attachObserver();
    this.attachWindowTracking();
    this.startTicker();

    if (nextSnapshot.focusedPostId && this.restoreFocus(nextSnapshot.focusedPostId, false)) {
      this.emit();
      this.persistSoon();
      return true;
    }

    this.focusNearestToViewportCenter(true);
    this.emit();
    this.persistSoon();
    return true;
  }

  async stop(reason: SessionSummary["reason"] = "manual"): Promise<void> {
    if (!this.state) {
      return;
    }

    if (this.state.snapshot.phase === "active" || this.state.snapshot.phase === "paused") {
      const summary: SessionSummary = {
        reason,
        viewedCount: this.state.snapshot.stats.viewedCount,
        durationMs: Math.max(0, Date.now() - this.state.snapshot.startedAt)
      };
      this.callbacks.onComplete?.(summary);
    }

    await setDailyUsage(this.dailyUsage);
    this.teardown();
    this.clearFocusMarkers();
    this.state = null;
    this.focusedHandle = null;
    await clearSessionSnapshot();
  }

  async pause(reason: Exclude<PauseReason, null>): Promise<void> {
    if (!this.state || this.state.snapshot.phase !== "active") {
      return;
    }

    this.routePauseReason = reason;
    this.state.snapshot.phase = transitionSessionPhase(this.state.snapshot.phase, { type: "pause", reason });
    this.state.snapshot.pauseReason = reason;
    this.state.snapshot.updatedAt = Date.now();
    this.persistSoon();
    this.emit();
  }

  async resume(): Promise<void> {
    if (!this.state || this.state.snapshot.phase !== "paused") {
      return;
    }

    this.routePauseReason = null;
    this.state.snapshot.phase = transitionSessionPhase(this.state.snapshot.phase, { type: "resume" });
    this.state.snapshot.pauseReason = null;
    this.state.snapshot.updatedAt = Date.now();
    this.lastTickAt = Date.now();
    this.persistSoon();
    this.emit();
  }

  hasRoutePause(): boolean {
    return this.routePauseReason === "details" || this.routePauseReason === "navigation";
  }

  getViewState(): DeckViewState | null {
    if (!this.state) {
      return null;
    }

    const focusedHandle = this.focusedHandle ? this.findHandleById(this.focusedHandle.id) : null;
    return {
      snapshot: this.cloneSnapshot(this.state.snapshot),
      focusedHandle,
      focusedMeta: focusedHandle ? this.adapter.getPostMeta(focusedHandle) : null,
      feedCount: this.adapter.getFeedItems().length
    };
  }

  async next(): Promise<boolean> {
    if (!this.state || this.state.snapshot.phase !== "active") {
      return false;
    }

    const items = this.adapter.getFeedItems();
    if (!items.length) {
      return false;
    }

    const currentId = this.state.snapshot.focusedPostId;
    const currentIndex = currentId ? items.findIndex((item) => item.id === currentId) : -1;
    const nextHandle = items[currentIndex + 1] ?? null;

    if (!nextHandle) {
      this.adapter.triggerLazyLoad?.(items[Math.max(0, currentIndex)]);
      return false;
    }

    this.adapter.focusItem(nextHandle);
    this.applyFocusedHandle(nextHandle, true);
    return true;
  }

  async previous(): Promise<boolean> {
    if (!this.state || this.state.snapshot.phase !== "active") {
      return false;
    }

    const items = this.adapter.getFeedItems();
    if (!items.length) {
      return false;
    }

    const currentId = this.state.snapshot.focusedPostId;
    const currentIndex = currentId ? items.findIndex((item) => item.id === currentId) : -1;
    const previousHandle = currentIndex > 0 ? items[currentIndex - 1] : null;

    if (!previousHandle) {
      return false;
    }

    this.adapter.focusItem(previousHandle);
    this.applyFocusedHandle(previousHandle, true);
    return true;
  }

  focusNearestToViewportCenter(force = false, countView = true): void {
    if (!this.state || this.state.snapshot.phase !== "active") {
      return;
    }

    const handles = this.adapter.getFeedItems();
    if (!handles.length) {
      return;
    }

    const viewportCenter = window.innerHeight / 2;
    let best: { handle: PostHandle; distance: number } | null = null;

    for (const handle of handles) {
      const rect = handle.element.getBoundingClientRect();
      const visible = rect.bottom > 0 && rect.top < window.innerHeight && rect.height > 20;
      if (!visible) {
        continue;
      }

      const center = rect.top + rect.height / 2;
      const distance = Math.abs(center - viewportCenter);
      if (!best || distance < best.distance) {
        best = { handle, distance };
      }
    }

    if (!best) {
      return;
    }

    if (!force && this.state.snapshot.focusedPostId === best.handle.id) {
      return;
    }

    this.applyFocusedHandle(best.handle, countView);
  }

  restoreFocus(postId: string | null, countView = false): boolean {
    if (!postId || !this.state) {
      return false;
    }

    const handle = this.findHandleById(postId);
    if (!handle) {
      return false;
    }

    this.adapter.focusItem(handle);
    this.applyFocusedHandle(handle, countView);
    return true;
  }

  async runAction(action: AdapterAction, userGesture = false): Promise<ActionResult> {
    if (!this.state || this.state.snapshot.phase !== "active") {
      return { ok: false, message: "Start or resume a session first." };
    }

    if ((action === "notInterested" || action === "bookmark") && !userGesture) {
      return { ok: false, message: "Action requires an explicit user gesture." };
    }

    const focused = this.state.snapshot.focusedPostId ? this.findHandleById(this.state.snapshot.focusedPostId) : null;
    if (!focused) {
      return { ok: false, message: "No focused post found." };
    }

    try {
      const result = await this.dispatcher.dispatch(() => this.executeAction(action, focused));
      if (!result.ok) {
        this.emit();
        return result;
      }

      if (action === "notInterested") {
        this.state.snapshot.stats.actions.notInterested += 1;
      } else if (action === "bookmark") {
        this.state.snapshot.stats.actions.bookmarked += 1;
      }

      this.state.snapshot.updatedAt = Date.now();
      this.persistSoon();
      this.emit();
      return result;
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Action failed."
      };
    }
  }

  extendSession(additionalPosts: number, additionalMinutes: number): void {
    if (!this.state) {
      return;
    }

    const nextPosts = Math.max(1, this.state.snapshot.config.postLimit + Math.max(0, Math.floor(additionalPosts)));
    const nextMinutes = Math.max(1, this.state.snapshot.config.timeLimitMinutes + Math.max(0, Math.floor(additionalMinutes)));
    this.state.snapshot.config = {
      ...this.state.snapshot.config,
      postLimit: nextPosts,
      timeLimitMinutes: nextMinutes
    };

    if (this.state.snapshot.phase === "completed") {
      this.state.snapshot.phase = "active";
      this.state.snapshot.pauseReason = null;
    }

    this.state.snapshot.updatedAt = Date.now();
    this.lastTickAt = Date.now();
    this.persistSoon();
    this.emit();
  }

  grantEmergencyMinutes(minutes: number): void {
    if (minutes <= 0) {
      return;
    }

    this.dailyUsage = applyUsageDelta(this.dailyUsage, this.adapter.id, {
      emergencyMs: Math.floor(minutes * 60_000)
    });
    this.callbacks.onDailyUsageUpdated?.(this.dailyUsage);
    this.persistSoon();
  }

  private async executeAction(action: AdapterAction, handle: PostHandle): Promise<ActionResult> {
    if (action === "notInterested") {
      return this.adapter.notInterested(handle);
    }

    if (action === "bookmark") {
      return this.adapter.bookmark(handle);
    }

    return { ok: false, message: "Unsupported action." };
  }

  private applyFocusedHandle(handle: PostHandle, countView: boolean): void {
    if (!this.state) {
      return;
    }

    this.focusedHandle = handle;
    this.state.snapshot.focusedPostId = handle.id;
    this.state.snapshot.updatedAt = Date.now();

    if (countView && this.callbacks.canCountProgress?.() !== false) {
      const progressKey = this.adapter.getProgressKey ? this.adapter.getProgressKey(handle) : handle.id;
      if (progressKey && !this.state.viewedIdSet.has(progressKey)) {
        this.state.viewedIdSet.add(progressKey);
        this.state.snapshot.stats.viewedPostIds = [...this.state.viewedIdSet];
        this.state.snapshot.stats.viewedCount = this.state.viewedIdSet.size;
        this.dailyUsage = applyUsageDelta(this.dailyUsage, this.adapter.id, { postsViewed: 1 });
        this.callbacks.onDailyUsageUpdated?.(this.dailyUsage);
      }
    }

    this.checkSessionLimit();
    this.checkDailyLimits();
    this.persistSoon();
    this.emit();
  }

  private checkSessionLimit(): void {
    if (!this.state || this.state.snapshot.phase !== "active") {
      return;
    }

    const { config, stats } = this.state.snapshot;
    if (config.mode === "posts" && config.postLimit > 0 && stats.viewedCount >= config.postLimit) {
      this.complete("posts-limit");
      return;
    }

    if (config.mode === "time" && config.timeLimitMinutes > 0 && stats.activeMs >= config.timeLimitMinutes * 60_000) {
      this.complete("time-limit");
    }
  }

  private checkDailyLimits(): void {
    if (!this.state || this.state.snapshot.phase !== "active") {
      return;
    }

    if (!isDailyLimitReached(this.dailyLimits, this.dailyUsage, this.adapter.id)) {
      return;
    }

    this.state.snapshot.phase = transitionSessionPhase(this.state.snapshot.phase, { type: "pause", reason: "limit" });
    this.state.snapshot.pauseReason = "limit";
    this.state.snapshot.updatedAt = Date.now();
    this.callbacks.onDailyLimitReached?.();
  }

  private complete(reason: SessionSummary["reason"]): void {
    if (!this.state) {
      return;
    }

    this.state.snapshot.phase = transitionSessionPhase(this.state.snapshot.phase, { type: "complete" });
    this.state.snapshot.pauseReason = "limit";
    this.state.snapshot.updatedAt = Date.now();

    const summary: SessionSummary = {
      reason,
      viewedCount: this.state.snapshot.stats.viewedCount,
      durationMs: Math.max(0, Date.now() - this.state.snapshot.startedAt)
    };
    this.callbacks.onComplete?.(summary);
    this.persistSoon();
    this.emit();
  }

  private attachObserver(): void {
    this.observerCleanup?.();
    this.observerCleanup = this.adapter.observeFeedChanges?.(() => {
      const currentFocusedId = this.state?.snapshot.focusedPostId ?? null;
      const currentFocusedHandle = currentFocusedId ? this.findHandleById(currentFocusedId) : null;
      const shouldCountFromMutation =
        !this.isHandleVisible(currentFocusedHandle) || !this.isHandleNearViewportCenter(currentFocusedHandle);
      this.focusNearestToViewportCenter(false, shouldCountFromMutation);
      this.emit();
    }) ?? null;
  }

  private attachWindowTracking(): void {
    const onViewportChange = () => {
      if (this.scrollRafId) {
        return;
      }

      this.scrollRafId = window.requestAnimationFrame(() => {
        this.scrollRafId = 0;
        this.focusNearestToViewportCenter(false);
      });
    };

    const scrollOptions: AddEventListenerOptions = { passive: true, capture: true };
    const keyOptions: AddEventListenerOptions = { capture: true };
    const timelineScroller = document.querySelector("[data-testid='primaryColumn']");
    const mainScroller = document.querySelector("main");
    const rootScroller = document.scrollingElement;
    const scrollTargets: EventTarget[] = [document, window];
    if (rootScroller) {
      scrollTargets.push(rootScroller);
    }
    if (mainScroller) {
      scrollTargets.push(mainScroller);
    }
    if (timelineScroller) {
      scrollTargets.push(timelineScroller);
    }
    const uniqueScrollTargets = Array.from(new Set(scrollTargets));

    for (const target of uniqueScrollTargets) {
      target.addEventListener("scroll", onViewportChange, scrollOptions);
    }
    document.addEventListener("wheel", onViewportChange, scrollOptions);
    document.addEventListener("touchmove", onViewportChange, scrollOptions);
    document.addEventListener("keydown", onViewportChange, keyOptions);

    window.addEventListener("resize", onViewportChange, { passive: true });

    const cleanup = this.observerCleanup;
    this.observerCleanup = () => {
      cleanup?.();

      for (const target of uniqueScrollTargets) {
        target.removeEventListener("scroll", onViewportChange, scrollOptions);
      }
      document.removeEventListener("wheel", onViewportChange, scrollOptions);
      document.removeEventListener("touchmove", onViewportChange, scrollOptions);
      document.removeEventListener("keydown", onViewportChange, keyOptions);

      window.removeEventListener("resize", onViewportChange);
      if (this.scrollRafId) {
        window.cancelAnimationFrame(this.scrollRafId);
        this.scrollRafId = 0;
      }
    };
  }

  private startTicker(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
    }

    this.timerId = window.setInterval(() => {
      if (!this.state || this.state.snapshot.phase !== "active") {
        this.lastTickAt = Date.now();
        return;
      }

      const now = Date.now();
      const delta = Math.max(0, now - this.lastTickAt);
      this.lastTickAt = now;

      if (document.visibilityState !== "visible") {
        return;
      }

      if (this.callbacks.canCountTime?.() === false) {
        return;
      }

      this.state.snapshot.stats.activeMs += delta;
      this.state.snapshot.updatedAt = now;
      this.dailyUsage = applyUsageDelta(this.dailyUsage, this.adapter.id, { activeMs: delta });
      this.callbacks.onDailyUsageUpdated?.(this.dailyUsage);

      this.checkSessionLimit();
      this.checkDailyLimits();
      this.persistSoon();
      this.emit();
    }, 1000);
  }

  private findHandleById(id: string): PostHandle | null {
    if (this.adapter.findHandleById) {
      const handle = this.adapter.findHandleById(id);
      if (handle) {
        return handle;
      }
    }

    return this.adapter.getFeedItems().find((handle) => handle.id === id) ?? null;
  }

  private cloneSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
    return {
      ...snapshot,
      config: {
        ...snapshot.config
      },
      stats: {
        ...snapshot.stats,
        viewedPostIds: [...snapshot.stats.viewedPostIds],
        actions: {
          ...snapshot.stats.actions
        }
      }
    };
  }

  private isHandleVisible(handle: PostHandle | null): boolean {
    if (!handle) {
      return false;
    }

    const rect = handle.element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.height > 20;
  }

  private isHandleNearViewportCenter(handle: PostHandle | null): boolean {
    if (!handle) {
      return false;
    }

    const rect = handle.element.getBoundingClientRect();
    if (rect.height <= 20) {
      return false;
    }

    const viewportCenter = window.innerHeight / 2;
    const handleCenter = rect.top + rect.height / 2;
    const maxDistance = Math.max(140, window.innerHeight * 0.2);
    return Math.abs(handleCenter - viewportCenter) <= maxDistance;
  }

  private persistSoon(): void {
    if (!this.state) {
      return;
    }

    if (this.persistTimerId !== null) {
      return;
    }

    this.persistTimerId = window.setTimeout(() => {
      this.persistTimerId = null;
      void this.persistNow();
    }, 250);
  }

  private async persistNow(): Promise<void> {
    if (!this.state) {
      return;
    }

    await Promise.all([setSessionSnapshot(this.state.snapshot), setDailyUsage(this.dailyUsage)]);
  }

  private clearFocusMarkers(): void {
    document.querySelectorAll<HTMLElement>("[data-focusdeck-focused='true']").forEach((node) => {
      node.removeAttribute("data-focusdeck-focused");
    });
    document.querySelectorAll<HTMLElement>("[data-focusdeck-dimmed='true']").forEach((node) => {
      node.removeAttribute("data-focusdeck-dimmed");
    });
    document.querySelectorAll<HTMLElement>("[data-focusdeck-sidebar='true']").forEach((node) => {
      node.removeAttribute("data-focusdeck-sidebar");
    });
  }

  private teardown(): void {
    this.observerCleanup?.();
    this.observerCleanup = null;

    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }

    if (this.persistTimerId !== null) {
      window.clearTimeout(this.persistTimerId);
      this.persistTimerId = null;
    }
  }

  private emit(): void {
    const view = this.getViewState();
    if (!view) {
      return;
    }

    for (const listener of this.listeners) {
      listener(view);
    }
  }
}
