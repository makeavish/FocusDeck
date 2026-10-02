import { isDailyLimitReached, localDateKey, normalizeUsageForDate } from "@/core/daily-counter";
import { transitionSessionPhase } from "@/core/session-state";
import { acknowledgeDailyView, clearOwnedSessionSnapshot, commitDailyView, releaseDailyView, reserveDailyView, saveOwnedSessionSnapshot, type ViewRequest } from "@/shared/runtime-state";
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
  feedItems: PostHandle[];
}

interface RuntimeState {
  snapshot: SessionSnapshot;
  viewedIdSet: Set<string>;
}

interface EngineCallbacks {
  observeFeed?: boolean;
  reconcileOwnership?: (snapshot: SessionSnapshot) => Promise<SessionSnapshot | null>;
  onComplete?: (summary: SessionSummary) => void;
  onDailyLimitReached?: () => void;
  onDailyUsageUpdated?: (usage: DailyUsage) => void;
  canCountProgress?: () => boolean;
  onError?: (message: string) => void;
}

type StateListener = (state: DeckViewState) => void;

const EMPTY_STATS: SessionStats = {
  viewedCount: 0,
  viewedPostIds: [],
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
  private scrollRafId = 0;
  private persistTimerId: number | null = null;
  private routePauseReason: PauseReason = null;
  private generation = 0;
  private pendingFocus: Promise<boolean> | null = null;
  private readonly unsettledViews = new Map<string, ViewRequest>();
  private dailyContextRevision = 0;
  private ownershipReconciliation: Promise<boolean> | null = null;

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
    this.dailyContextRevision += 1;
    this.dailyLimits = limits;
    this.dailyUsage = normalizeUsageForDate(usage, localDateKey());
    if (!this.pendingFocus) {
      this.checkDailyLimits();
      this.emit();
    }
  }

  async reconcileOwnership(): Promise<boolean> {
    const reconcile = this.callbacks.reconcileOwnership;
    if (!this.state || !reconcile) return true;
    if (this.ownershipReconciliation) return this.ownershipReconciliation;
    const state = this.state;
    this.ownershipReconciliation = (async () => {
      const snapshot = await reconcile(this.cloneSnapshot(state.snapshot)).catch(() => null);
      if (this.state !== state) return false;
      if (!snapshot || snapshot.sessionId !== state.snapshot.sessionId) {
        await this.pause("manual");
        this.callbacks.onError?.("Session ownership is unavailable. Stop this session or reload to start again.");
        return false;
      }
      state.viewedIdSet = new Set(snapshot.stats.viewedPostIds);
      state.snapshot.stats.viewedPostIds = [...state.viewedIdSet];
      state.snapshot.stats.viewedCount = state.viewedIdSet.size;
      state.snapshot.pendingPresentations = snapshot.pendingPresentations;
      return true;
    })();
    try {
      return await this.ownershipReconciliation;
    } finally {
      this.ownershipReconciliation = null;
    }
  }

  getDailyUsage(): DailyUsage {
    return this.dailyUsage;
  }

  getPhase(): SessionSnapshot["phase"] {
    return this.state?.snapshot.phase ?? "idle";
  }

  getPauseReason(): PauseReason {
    return this.state?.snapshot.pauseReason ?? null;
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
    if (this.state) {
      return false;
    }
    const feedItems = this.adapter.getFeedItems();
    if (!feedItems.length) {
      return false;
    }

    const resumed = Boolean(snapshot && snapshot.adapterId === this.adapter.id);
    const stats = resumed && snapshot ? { ...snapshot.stats } : { ...EMPTY_STATS };
    const viewedSet = new Set(stats.viewedPostIds);
    const nextSnapshot: SessionSnapshot = {
      sessionId: resumed && snapshot?.sessionId ? snapshot.sessionId : crypto.randomUUID(),
      ...(resumed && snapshot?.pendingPresentations ? { pendingPresentations: [...snapshot.pendingPresentations] } : {}),
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

    const savedSnapshot = await saveOwnedSessionSnapshot(this.cloneSnapshot(nextSnapshot));
    if (this.state?.snapshot !== nextSnapshot) return false;
    nextSnapshot.sessionId = savedSnapshot.sessionId ?? nextSnapshot.sessionId;
    nextSnapshot.stats = savedSnapshot.stats;
    nextSnapshot.pendingPresentations = savedSnapshot.pendingPresentations;
    viewedSet.clear();
    for (const key of nextSnapshot.stats.viewedPostIds) viewedSet.add(key);
    // Present already-charged progress before applying either cap to recovery.
    const pendingHandle = this.adapter.getFeedItems().find((handle) => nextSnapshot.pendingPresentations?.some((pending) =>
      pending.progressKey === (this.adapter.getProgressKey ? this.adapter.getProgressKey(handle) : handle.id) &&
      (!pending.postId || pending.postId === handle.id)));
    if (pendingHandle && await this.applyFocusedHandle(pendingHandle, false)) {
      this.adapter.focusItem(pendingHandle);
      if (this.state && this.state.snapshot.phase !== "completed") {
        this.attachObserver();
        this.attachWindowTracking();
      }
      return true;
    }
    if (nextSnapshot.pendingPresentations?.length) {
      // An absent charged card must stay recoverable rather than complete unseen or expose a replacement.
      const reached = isDailyLimitReached(this.dailyLimits, normalizeUsageForDate(this.dailyUsage, localDateKey()), this.adapter.id);
      await this.pause(reached ? "limit" : "manual");
      if (reached) this.callbacks.onDailyLimitReached?.();
      return true;
    }
    if (nextSnapshot.config.postLimit > 0 && nextSnapshot.stats.viewedCount >= nextSnapshot.config.postLimit) {
      this.checkDailyLimits();
      this.checkSessionLimit();
      return true;
    }
    this.attachObserver();
    this.attachWindowTracking();

    if (nextSnapshot.focusedPostId && await this.restoreFocus(nextSnapshot.focusedPostId, false)) {
      this.emit();
      this.persistSoon();
      return true;
    }

    if (resumed) {
      await this.focusNearestToViewportCenter(true);
    } else if (!await this.focusFirstVisible(true)) {
      await this.focusNearestToViewportCenter(true);
    }
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

    await this.dispose();
    await clearOwnedSessionSnapshot();
  }

  async dispose(): Promise<void> {
    this.generation += 1;
    this.teardown();
    this.clearFocusMarkers();
    this.state = null;
    this.focusedHandle = null;
    await this.pendingFocus;
    for (const view of this.unsettledViews.values()) await this.releaseView(view);
  }

  private async releaseView(view: ViewRequest) {
    const result = await releaseDailyView(view);
    this.unsettledViews.delete(view.requestId);
    return result;
  }

  async pause(reason: Exclude<PauseReason, null>): Promise<void> {
    if (!this.state || this.state.snapshot.phase !== "active") {
      return;
    }

    this.generation += 1;
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

    if (isDailyLimitReached(this.dailyLimits, normalizeUsageForDate(this.dailyUsage, localDateKey()), this.adapter.id)) {
      this.callbacks.onDailyLimitReached?.();
      return;
    }
    this.generation += 1;
    this.routePauseReason = null;
    this.state.snapshot.phase = transitionSessionPhase(this.state.snapshot.phase, { type: "resume" });
    this.state.snapshot.pauseReason = null;
    this.state.snapshot.updatedAt = Date.now();
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

    const feedItems = this.adapter.getFeedItems();
    const focusedHandle = this.focusedHandle
      ? feedItems.find((handle) => handle.element === this.focusedHandle?.element && handle.id === this.focusedHandle.id) ??
        feedItems.find((handle) => handle.id === this.focusedHandle?.id) ?? null
      : null;
    return {
      snapshot: this.cloneSnapshot(this.state.snapshot),
      focusedHandle,
      focusedMeta: focusedHandle ? this.adapter.getPostMeta(focusedHandle) : null,
      feedCount: feedItems.length,
      feedItems
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
    const currentIndex = currentId ? items.findIndex((item) => item.element === this.focusedHandle?.element && item.id === currentId) : -1;
    const nextHandle = items[currentIndex + 1] ?? null;

    if (!nextHandle) {
      this.adapter.triggerLazyLoad?.(items[Math.max(0, currentIndex)]);
      return false;
    }

    const moved = await this.applyFocusedHandle(nextHandle, true);
    if (moved) {
      this.adapter.focusItem(nextHandle);
    }
    return moved;
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
    const currentIndex = currentId ? items.findIndex((item) => item.element === this.focusedHandle?.element && item.id === currentId) : -1;
    const previousHandle = currentIndex > 0 ? items[currentIndex - 1] : null;

    if (!previousHandle) {
      return false;
    }

    const moved = await this.applyFocusedHandle(previousHandle, true);
    if (moved) {
      this.adapter.focusItem(previousHandle);
    }
    return moved;
  }

  async focusNearestToViewportCenter(force = false, countView = true): Promise<boolean> {
    if (!this.state || this.state.snapshot.phase !== "active") {
      return false;
    }

    const handles = this.adapter.getFeedItems();
    if (!handles.length) {
      return false;
    }

    const visible = handles
      .map((handle) => ({ handle, rect: handle.element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > 0 && rect.top < window.innerHeight && rect.height > 20);
    if (!visible.length) {
      return false;
    }

    const topmostVisible = [...visible].sort((left, right) => {
      if (left.rect.top === right.rect.top) {
        return left.rect.left - right.rect.left;
      }
      return left.rect.top - right.rect.top;
    })[0]?.handle;
    if (!topmostVisible) {
      return false;
    }

    let nextHandle = topmostVisible;
    if (!this.isNearFeedTop()) {
      const viewportCenter = window.innerHeight / 2;
      let best: { handle: PostHandle; distance: number } | null = null;

      for (const item of visible) {
        const center = item.rect.top + item.rect.height / 2;
        const distance = Math.abs(center - viewportCenter);
        if (!best || distance < best.distance) {
          best = { handle: item.handle, distance };
        }
      }

      if (!best) {
        return false;
      }

      nextHandle = best.handle;
    }

    if (!force && this.state.snapshot.focusedPostId === nextHandle.id && this.focusedHandle?.element === nextHandle.element) {
      return true;
    }

    return this.applyFocusedHandle(nextHandle, countView);
  }

  private async focusFirstVisible(countView = true): Promise<boolean> {
    if (!this.state || this.state.snapshot.phase !== "active") {
      return false;
    }

    const handles = this.adapter.getFeedItems();
    if (!handles.length) {
      return false;
    }

    const visible = handles
      .map((handle) => ({ handle, rect: handle.element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > 0 && rect.top < window.innerHeight && rect.height > 20)
      .sort((left, right) => {
        if (left.rect.top === right.rect.top) {
          return left.rect.left - right.rect.left;
        }
        return left.rect.top - right.rect.top;
      });

    const firstVisible = visible[0]?.handle;
    if (!firstVisible) {
      return false;
    }

    return this.applyFocusedHandle(firstVisible, countView);
  }

  async restoreFocus(postId: string | null, countView = false): Promise<boolean> {
    if (!postId || !this.state) {
      return false;
    }

    const handle = this.findHandleById(postId);
    if (!handle) {
      return false;
    }

    const restored = await this.applyFocusedHandle(handle, countView);
    if (restored) {
      this.adapter.focusItem(handle);
    }
    return restored;
  }

  async runAction(action: AdapterAction, userGesture = false): Promise<ActionResult> {
    if (!this.state || this.state.snapshot.phase !== "active") {
      return { ok: false, message: "Start or resume a session first." };
    }

    if ((action === "notInterested" || action === "bookmark") && !userGesture) {
      return { ok: false, message: "Action requires an explicit user gesture." };
    }

    const focused = this.getViewState()?.focusedHandle ?? null;
    if (!focused) {
      return { ok: false, message: "No focused post found." };
    }

    const actionState = this.state;
    const generation = this.generation;
    const permalink = this.adapter.getPermalink?.(focused);
    const isCurrent = () => this.state === actionState && this.generation === generation &&
      actionState.snapshot.phase === "active" && focused.element.isConnected &&
      this.callbacks.canCountProgress?.() !== false &&
      this.adapter.getFeedItems().some((handle) => handle.element === focused.element && handle.id === focused.id) &&
      this.adapter.getPermalink?.(focused) === permalink;

    try {
      const result = await this.dispatcher.dispatch(() => isCurrent()
        ? this.executeAction(action, focused, isCurrent)
        : { ok: false, message: "Post or session changed. Try again." });
      if (!result.ok || !isCurrent()) {
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

  private async executeAction(action: AdapterAction, handle: PostHandle, isCurrent: () => boolean): Promise<ActionResult> {
    if (action === "notInterested") {
      return this.adapter.notInterested(handle, isCurrent);
    }

    if (action === "bookmark") {
      return this.adapter.bookmark(handle);
    }

    return { ok: false, message: "Unsupported action." };
  }

  private async applyFocusedHandle(handle: PostHandle, _countView: boolean): Promise<boolean> {
    if (!this.state || this.state.snapshot.phase !== "active" || this.pendingFocus || this.callbacks.canCountProgress?.() === false) {
      return false;
    }

    const state = this.state;
    const generation = this.generation;
    // Restoration only skips progress that this session has already viewed.
    const progressKey = this.adapter.getProgressKey ? this.adapter.getProgressKey(handle) : handle.id;
    let isNew = false;
    let pendingPresentation = false;
    const revision = this.dailyContextRevision;
    let view = { sessionId: state.snapshot.sessionId!, requestId: crypto.randomUUID(), progressKey: progressKey ?? "", postId: handle.id };
    const isCurrent = () => this.state === state && this.generation === generation && state.snapshot.phase === "active" &&
      this.callbacks.canCountProgress?.() !== false &&
      this.adapter.getFeedItems().some((item) => item.element === handle.element && item.id === handle.id);
    const updateContext = (result: { limits: DailyLimitsConfig; usage: DailyUsage }) => {
      if (revision === this.dailyContextRevision) {
        this.dailyLimits = result.limits;
        this.dailyUsage = result.usage;
      }
    };
    const task = async (): Promise<boolean> => {
      if (this.callbacks.reconcileOwnership && !await this.reconcileOwnership()) return false;
      if (!isCurrent()) return false;
      isNew = Boolean(progressKey && !state.viewedIdSet.has(progressKey));
      pendingPresentation = state.snapshot.pendingPresentations?.some((pending) => pending.progressKey === progressKey) ?? false;
      if (state.snapshot.pendingPresentations?.length && !pendingPresentation) return false;
      if (isNew && state.snapshot.config.postLimit > 0 && state.snapshot.stats.viewedCount >= state.snapshot.config.postLimit) {
        this.checkSessionLimit();
        return false;
      }
      if (isNew) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          this.unsettledViews.set(view.requestId, view);
          try {
            const reservation = await reserveDailyView(view);
            updateContext(reservation);
            if (!reservation.allowed || !isCurrent()) {
              updateContext(await this.releaseView(view));
              this.checkDailyLimits();
              if (isCurrent()) {
                await this.pause("manual");
                this.callbacks.onError?.("Unable to reserve this post. Start the session again to retry.");
              }
              this.emit();
              return false;
            }
            const result = await commitDailyView(view);
            updateContext(result);
            if (!result.allowed || !isCurrent()) {
              updateContext(await this.releaseView(view));
              if (!result.allowed && result.denialReason === "expired" && isCurrent() && attempt === 0) {
                view = { ...view, requestId: crypto.randomUUID() };
                continue;
              }
              this.checkDailyLimits();
              if (isCurrent()) {
                await this.pause("manual");
                this.callbacks.onError?.("Unable to record this post. Start the session again to retry.");
              }
              this.emit();
              return false;
            }
            // The charge and key are durable before exposure.
            break;
          } catch (error) {
            await this.releaseView(view).catch(() => undefined);
            throw error;
          }
        }
      } else if (!isCurrent()) {
        return false;
      }

      this.focusedHandle = handle;
      state.snapshot.focusedPostId = handle.id;
      state.snapshot.updatedAt = Date.now();
      if (isNew && progressKey) {
        state.viewedIdSet.add(progressKey);
        state.snapshot.stats.viewedPostIds = [...state.viewedIdSet];
        state.snapshot.stats.viewedCount = state.viewedIdSet.size;
        this.callbacks.onDailyUsageUpdated?.(this.dailyUsage);
      }
      if (isNew || pendingPresentation) {
        this.emit();
        void acknowledgeDailyView(view).catch(() => undefined);
        this.unsettledViews.delete(view.requestId);
        state.snapshot.pendingPresentations = state.snapshot.pendingPresentations?.filter((pending) => pending.progressKey !== progressKey);
      }
      this.checkDailyLimits();
      this.checkSessionLimit();
      this.persistSoon();
      this.emit();
      return true;
    };
    this.pendingFocus = task().catch(async (error: unknown) => {
      if (error instanceof Error && error.message === "Session ownership changed." && this.callbacks.reconcileOwnership) {
        if (!isCurrent() || !await this.reconcileOwnership()) {
          this.unsettledViews.delete(view.requestId);
          return false;
        }
        if (!state.viewedIdSet.has(view.progressKey)) await this.releaseView(view).catch(() => undefined);
        this.unsettledViews.delete(view.requestId);
        view = { ...view, requestId: crypto.randomUUID() };
        try {
          return await task();
        } catch (retryError) {
          if (retryError instanceof Error && retryError.message === "Session ownership changed.") this.unsettledViews.delete(view.requestId);
          await this.pause("manual");
          this.callbacks.onError?.("Session recovery was interrupted. Start the session again to retry.");
          return false;
        }
      }
      await this.pause("manual");
      this.callbacks.onError?.(error instanceof Error ? error.message : "Failed to record the post view.");
      return false;
    });
    try {
      return await this.pendingFocus;
    } finally {
      this.pendingFocus = null;
    }
  }

  private checkSessionLimit(): void {
    if (!this.state || (this.state.snapshot.phase !== "active" && this.state.snapshot.phase !== "paused")) {
      return;
    }

    const { config, stats } = this.state.snapshot;
    if (config.postLimit > 0 && stats.viewedCount >= config.postLimit) {
      this.complete("posts-limit");
    }
  }

  private checkDailyLimits(): void {
    if (!this.state) {
      return;
    }
    this.dailyUsage = normalizeUsageForDate(this.dailyUsage, localDateKey());
    const reached = isDailyLimitReached(this.dailyLimits, this.dailyUsage, this.adapter.id);
    if (!reached) {
      if (this.state.snapshot.phase === "paused" && this.state.snapshot.pauseReason === "limit" && this.callbacks.canCountProgress?.() !== false) {
        void this.resume();
      }
      return;
    }
    if (this.state.snapshot.phase === "active") {
      this.generation += 1;
      this.state.snapshot.phase = transitionSessionPhase(this.state.snapshot.phase, { type: "pause", reason: "limit" });
      this.state.snapshot.pauseReason = "limit";
      this.state.snapshot.updatedAt = Date.now();
      this.persistSoon();
    }
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
    if (this.callbacks.observeFeed === false) return;
    this.observerCleanup = this.adapter.observeFeedChanges?.(() => {
      const currentFocusedId = this.state?.snapshot.focusedPostId ?? null;
      const currentFocusedHandle = currentFocusedId ? this.findHandleById(currentFocusedId) : null;
      const isFocusedHandleVisible = this.isHandleVisible(currentFocusedHandle);
      if (currentFocusedHandle && isFocusedHandleVisible) {
        this.emit();
        return;
      }

      void this.focusNearestToViewportCenter(false, true).then(() => this.emit());
    }) ?? null;
  }

  private attachWindowTracking(): void {
    const onViewportChange = () => {
      if (this.scrollRafId) {
        return;
      }

      this.scrollRafId = window.requestAnimationFrame(() => {
        this.scrollRafId = 0;
        void this.focusNearestToViewportCenter(false);
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

  private isNearFeedTop(): boolean {
    const epsilonPx = 2;
    const offsets: number[] = [];
    const pushOffset = (value: number | null | undefined): void => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return;
      }
      offsets.push(Math.max(0, value));
    };

    const windowTop = typeof window.scrollY === "number" ? window.scrollY : window.pageYOffset;
    pushOffset(windowTop);

    const candidateNodes = [
      document.querySelector<HTMLElement>("[data-testid='primaryColumn']"),
      document.querySelector<HTMLElement>("main"),
      document.scrollingElement as HTMLElement | null,
      document.documentElement,
      document.body
    ].filter((node): node is HTMLElement => Boolean(node));

    const uniqueNodes = Array.from(new Set(candidateNodes));
    for (const node of uniqueNodes) {
      if (node.scrollHeight > node.clientHeight + epsilonPx || node.scrollTop > epsilonPx) {
        pushOffset(node.scrollTop);
      }
    }

    if (!offsets.length) {
      return true;
    }

    return offsets.every((offset) => offset <= epsilonPx);
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
      void this.persistNow().catch(() => undefined);
    }, 250);
  }

  private async persistNow(): Promise<void> {
    if (!this.state) {
      return;
    }

    await saveOwnedSessionSnapshot(this.cloneSnapshot(this.state.snapshot));
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
