import { XAdapter } from "@/adapters/x-adapter";
import { AdapterRegistry } from "@/core/adapter-registry";
import { ActionDispatcher } from "@/core/action-dispatcher";
import { isDailyLimitReached } from "@/core/daily-counter";
import { DeckEngine } from "@/core/deck-engine";
import { installKeyboardShortcuts } from "@/content/keyboard";
import { OverlayController } from "@/content/overlay/overlay";
import { browserApi } from "@/shared/browser-polyfill";
import { STORAGE_KEYS } from "@/shared/constants";
import {
  getDailyLimits,
  getDailyUsage,
  getSessionConfig,
  getSessionSnapshot,
  getSiteSettings
} from "@/shared/storage";
import type { AdapterAction } from "@/types/adapter";
import type { RuntimeMessage, RuntimeResponse, SiteSettings } from "@/types/messages";
import type { DailyUsage, SessionConfig, SessionSnapshot } from "@/types/session";

const registry = new AdapterRegistry();
registry.register(new XAdapter());

const adapter = registry.resolve(window.location.href);

const FOCUS_STYLE_ID = "focusdeck-native-layer-style";
const dispatcher = new ActionDispatcher();

let overlay: OverlayController | null = null;
let engine: DeckEngine | null = null;
let siteSettings: SiteSettings | null = null;
let keyboardCleanup: (() => void) | null = null;
let statusTimerId: number | null = null;
let overlaySuppressed = false;
let overlaySuppressionTimerId: number | null = null;
let resumeRecoveryTimerIds: number[] = [];
let postLimitExploreMode = false;
let postLimitViewedProgressKeys = new Set<string>();
let postLimitEnforceRafId = 0;
let lastRoute = window.location.href;
let feedLocked = false;
let feedMutationObserver: MutationObserver | null = null;
let feedMutationRafId = 0;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function openSettingsPage(): Promise<void> {
  try {
    const response = (await browserApi.runtime.sendMessage({
      type: "focusdeck:open-settings"
    })) as RuntimeResponse | undefined;
    if (response?.ok) {
      return;
    }
  } catch {
    // fallback handled below
  }

  try {
    await browserApi.runtime.openOptionsPage();
    return;
  } catch {
    const url = browserApi.runtime.getURL("settings/settings.html");
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

async function closeFeedTab(): Promise<void> {
  try {
    const response = (await browserApi.runtime.sendMessage({
      type: "focusdeck:close-tab"
    })) as RuntimeResponse | undefined;

    if (response?.ok) {
      return;
    }
  } catch {
    // fallback handled below
  }

  await stopSession();
  setStatus("Couldn't close this tab. Session stopped instead.");
}

function ensureOverlay(): OverlayController {
  if (overlay) {
    return overlay;
  }

  overlay = new OverlayController({
    onStartSession: (partial) => {
      void startSession(partial);
    },
    onAction: (action) => {
      void runAction(action, true);
    },
    onDismissComplete: () => {
      void stopSession();
    },
    onStartNewSession: () => {
      overlay?.setCompletion(null);
      void startSession();
    },
    onExtendPosts: () => {
      if (!window.confirm("Extend this session by +5 posts?")) {
        return;
      }
      engine?.extendSession(5, 0);
      overlay?.setCompletion(null);
      setStatus("Extended by +5 posts.");
    },
    onExtendMinutes: () => {
      if (!window.confirm("Extend this session by +2 minutes?")) {
        return;
      }
      engine?.extendSession(0, 2);
      overlay?.setCompletion(null);
      setStatus("Extended by +2 minutes.");
    },
    onDismissDailyLimit: () => {
      void closeFeedTab();
    },
    onOpenSettings: () => {
      void openSettingsPage();
    }
  });

  overlay.mount();
  return overlay;
}

function applyThemeModeFromConfig(config: SessionConfig | null | undefined): void {
  ensureOverlay().setThemeMode(config?.themeMode ?? "system");
}

function setStatus(message: string, timeoutMs = 2400): void {
  const overlayRef = ensureOverlay();
  overlayRef.setStatus(message);

  if (statusTimerId !== null) {
    window.clearTimeout(statusTimerId);
  }

  statusTimerId = window.setTimeout(() => {
    overlay?.setStatus(null);
    statusTimerId = null;
  }, timeoutMs);
}

function showDailyLimitModal(usage?: DailyUsage | null): void {
  const overlayRef = ensureOverlay();
  const usageSource = usage ?? engine?.getDailyUsage() ?? null;
  const siteUsage = usageSource && adapter ? usageSource.perSite[adapter.id] : undefined;
  const postsToday = usageSource ? Math.max(0, siteUsage?.postsViewed ?? usageSource.global.postsViewed) : null;
  overlayRef.setDailyLimitContext({
    postsToday,
    siteLabel: adapter?.name ?? "this site"
  });
  overlayRef.setDailyLimitReached(true);
}

function setOverlaySuppressed(next: boolean): void {
  overlaySuppressed = next;
  overlay?.setFocusLayerSuppressed(next);

  if (overlaySuppressionTimerId !== null) {
    window.clearTimeout(overlaySuppressionTimerId);
    overlaySuppressionTimerId = null;
  }

  if (!next) {
    return;
  }

  overlaySuppressionTimerId = window.setTimeout(() => {
    overlaySuppressed = false;
    overlaySuppressionTimerId = null;
    overlay?.setFocusLayerSuppressed(false);
  }, 3000);
}

function clearResumeRecoveryTimers(): void {
  for (const timerId of resumeRecoveryTimerIds) {
    window.clearTimeout(timerId);
  }
  resumeRecoveryTimerIds = [];
}

function scheduleResumeFocusRecovery(): void {
  clearResumeRecoveryTimers();
  const delays = [0, 120, 300, 650, 1100, 1700];

  for (const delay of delays) {
    const timerId = window.setTimeout(() => {
      if (!engine || engine.getPhase() !== "active" || !isFeedRoute(window.location.href)) {
        return;
      }

      const current = engine.getViewState();
      if (current?.focusedHandle) {
        applyFocusLayer(current);
        return;
      }

      engine.focusNearestToViewportCenter(true, false);
      const recovered = engine.getViewState();
      if (recovered?.focusedHandle) {
        applyFocusLayer(recovered);
      }
    }, delay);

    resumeRecoveryTimerIds.push(timerId);
  }
}

function ensureFocusLayerStyle(): void {
  if (document.getElementById(FOCUS_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = FOCUS_STYLE_ID;
  style.textContent = `
    [data-focusdeck-hidden='true'] {
      visibility: hidden !important;
      pointer-events: none !important;
      transition: visibility 0ms linear 100ms;
    }

    [data-focusdeck-locked='true'] {
      visibility: hidden !important;
      pointer-events: none !important;
    }

    [data-focusdeck-hidden-ui='true'] {
      display: none !important;
    }

    [data-focusdeck-post-limit-blocked='true'] {
      position: relative !important;
      overflow: hidden !important;
      pointer-events: auto !important;
      cursor: not-allowed !important;
    }

    [data-focusdeck-post-limit-blocked='true'] > * {
      filter: blur(40px) saturate(0) brightness(0.05) !important;
      opacity: 0 !important;
      pointer-events: none !important;
      user-select: none !important;
    }

    [data-focusdeck-post-limit-blocked='true']::before {
      content: "" !important;
      position: absolute !important;
      inset: 0 !important;
      background: rgba(4, 10, 18, 0.88) !important;
      z-index: 4 !important;
      pointer-events: auto !important;
    }

    [data-focusdeck-post-limit-blocked='true']::after {
      content: "Blocked in this session. Scroll up to viewed posts." !important;
      position: absolute !important;
      left: 50% !important;
      top: 50% !important;
      transform: translate(-50%, -50%) !important;
      z-index: 5 !important;
      color: #d8e8ff !important;
      background: rgba(8, 24, 45, 0.92) !important;
      border: 1px solid rgba(69, 118, 182, 0.6) !important;
      border-radius: 999px !important;
      padding: 8px 14px !important;
      font-size: 12px !important;
      font-weight: 700 !important;
      letter-spacing: 0.01em !important;
      white-space: nowrap !important;
      pointer-events: none !important;
    }

    [data-focusdeck-focused='true'] {
      visibility: visible !important;
      opacity: 1 !important;
      filter: none !important;
      outline: none !important;
      position: relative !important;
      border-radius: 14px !important;
      box-shadow: inset 0 0 0 2px rgba(26, 98, 214, 0.82) !important;
      pointer-events: auto !important;
      transition: opacity 120ms ease;
    }
  `;
  document.head.append(style);
}

function clearFocusLayer(): void {
  document.querySelectorAll<HTMLElement>("[data-focusdeck-focused='true']").forEach((node) => {
    node.removeAttribute("data-focusdeck-focused");
  });
  document.querySelectorAll<HTMLElement>("[data-focusdeck-hidden='true']").forEach((node) => {
    node.removeAttribute("data-focusdeck-hidden");
  });
  document.querySelectorAll<HTMLElement>("[data-focusdeck-locked='true']").forEach((node) => {
    node.removeAttribute("data-focusdeck-locked");
  });
  document.querySelectorAll<HTMLElement>("[data-focusdeck-dimmed='true']").forEach((node) => {
    node.removeAttribute("data-focusdeck-dimmed");
  });
  document.querySelectorAll<HTMLElement>("[data-focusdeck-hidden-ui='true']").forEach((node) => {
    node.removeAttribute("data-focusdeck-hidden-ui");
  });
  document.querySelectorAll<HTMLElement>("[data-focusdeck-post-limit-blocked='true']").forEach((node) => {
    node.removeAttribute("data-focusdeck-post-limit-blocked");
    (node as HTMLElement & { inert?: boolean }).inert = false;
  });
}

function clearPostLimitExploreMode(): void {
  postLimitExploreMode = false;
  postLimitViewedProgressKeys.clear();
  if (postLimitEnforceRafId) {
    window.cancelAnimationFrame(postLimitEnforceRafId);
    postLimitEnforceRafId = 0;
  }
  document.querySelectorAll<HTMLElement>("[data-focusdeck-post-limit-blocked='true']").forEach((node) => {
    node.removeAttribute("data-focusdeck-post-limit-blocked");
    (node as HTMLElement & { inert?: boolean }).inert = false;
  });
}

function enforcePostLimitExploreMode(): void {
  if (!postLimitExploreMode || !adapter || !isFeedRoute(window.location.href)) {
    return;
  }

  for (const handle of adapter.getFeedItems()) {
    const progressKey = adapter.getProgressKey ? adapter.getProgressKey(handle) : handle.id;
    const viewed = Boolean(progressKey && postLimitViewedProgressKeys.has(progressKey));

    if (viewed) {
      handle.element.removeAttribute("data-focusdeck-post-limit-blocked");
      (handle.element as HTMLElement & { inert?: boolean }).inert = false;
    } else {
      handle.element.setAttribute("data-focusdeck-post-limit-blocked", "true");
      (handle.element as HTMLElement & { inert?: boolean }).inert = true;
    }
  }
}

function schedulePostLimitEnforcement(): void {
  if (!postLimitExploreMode || postLimitEnforceRafId) {
    return;
  }

  postLimitEnforceRafId = window.requestAnimationFrame(() => {
    postLimitEnforceRafId = 0;
    enforcePostLimitExploreMode();
  });
}

function enablePostLimitExploreMode(viewedProgressKeys: Set<string>): void {
  if (!adapter) {
    return;
  }

  postLimitExploreMode = true;
  postLimitViewedProgressKeys = new Set(viewedProgressKeys);
  enforcePostLimitExploreMode();
}

function setFeedLocked(locked: boolean): void {
  if (!adapter) {
    return;
  }

  const shouldLock = locked && isFeedRoute(window.location.href);
  feedLocked = shouldLock;

  for (const handle of adapter.getFeedItems()) {
    if (shouldLock) {
      handle.element.setAttribute("data-focusdeck-locked", "true");
      handle.element.removeAttribute("data-focusdeck-focused");
      handle.element.removeAttribute("data-focusdeck-hidden");
      handle.element.removeAttribute("data-focusdeck-dimmed");
    } else {
      handle.element.removeAttribute("data-focusdeck-locked");
    }
  }
}

function isAdMarkerText(raw: string): boolean {
  const normalized = raw
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized === "ad" || normalized === "promoted" || normalized === "sponsored";
}

function isAdCell(cell: HTMLElement): boolean {
  const directAriaMarker = cell.querySelector<HTMLElement>(
    "[aria-label='Ad'], [aria-label='Promoted'], [aria-label='Sponsored']"
  );
  if (directAriaMarker) {
    return true;
  }

  const marker = Array.from(cell.querySelectorAll<HTMLElement>("span, div, a")).find((node) =>
    isAdMarkerText(node.textContent ?? "")
  );
  return Boolean(marker);
}

function setAuxiliaryUiHidden(hidden: boolean): void {
  document.querySelectorAll<HTMLElement>("[data-focusdeck-hidden-ui='true']").forEach((node) => {
    node.removeAttribute("data-focusdeck-hidden-ui");
  });

  if (!hidden) {
    return;
  }

  const targets = [
    "[data-testid='sidebarColumn']",
    "aside[role='complementary']",
    "[aria-label='Timeline: Trending now']",
    "[data-testid='whoToFollow']",
    "[aria-label='Who to follow']"
  ];

  for (const selector of targets) {
    document.querySelectorAll<HTMLElement>(selector).forEach((node) => {
      if (hidden) {
        node.setAttribute("data-focusdeck-hidden-ui", "true");
      } else {
        node.removeAttribute("data-focusdeck-hidden-ui");
      }
    });
  }

  const knownFeedArticles = new Set<HTMLElement>(adapter?.getFeedItems().map((handle) => handle.element) ?? []);
  const hasKnownFeedPosts = knownFeedArticles.size > 0;

  const feedCells = Array.from(
    document.querySelectorAll<HTMLElement>("main [data-testid='cellInnerDiv'], main [data-testid='placementTracking']")
  );

  for (const cell of feedCells) {
    const articles = Array.from(cell.querySelectorAll<HTMLElement>("article[data-testid='tweet'], article[role='article']"));
    const hasArticle = articles.length > 0;
    const isKnownPost = articles.some((article) => knownFeedArticles.has(article));
    const hideAsAd = isAdCell(cell);
    const hideAsNonFeedArticle = hasKnownFeedPosts && hasArticle && !isKnownPost;
    const hideAsPromotedModule = hasKnownFeedPosts && !hasArticle && cell.matches("[data-testid='placementTracking']");

    if (hideAsAd || hideAsNonFeedArticle || hideAsPromotedModule) {
      cell.setAttribute("data-focusdeck-hidden-ui", "true");
    }
  }
}

function ensureFeedMutationObserver(): void {
  if (feedMutationObserver) {
    return;
  }

  const target = document.querySelector("main") ?? document.body;
  if (!target) {
    return;
  }

  feedMutationObserver = new MutationObserver(() => {
    if (feedMutationRafId) {
      return;
    }

    feedMutationRafId = window.requestAnimationFrame(() => {
      feedMutationRafId = 0;

      if (postLimitExploreMode) {
        schedulePostLimitEnforcement();
        return;
      }

      if (feedLocked) {
        setFeedLocked(true);
        return;
      }

      if (engine) {
        const view = engine.getViewState();
        if (view?.snapshot.phase === "active" && !view.focusedHandle) {
          engine.focusNearestToViewportCenter(true, false);
        }
        applyFocusLayer(engine.getViewState());
      }
    });
  });

  feedMutationObserver.observe(target, {
    childList: true,
    subtree: true
  });
}

function applyFocusLayer(view: ReturnType<DeckEngine["getViewState"]>): void {
  if (!adapter) {
    clearFocusLayer();
    return;
  }

  if (view?.snapshot.phase === "paused" && view.snapshot.pauseReason === "details") {
    clearFocusLayer();
    setFeedLocked(false);
    setAuxiliaryUiHidden(false);
    return;
  }

  setAuxiliaryUiHidden(isFeedRoute(window.location.href));

  if (!view) {
    clearFocusLayer();
    setFeedLocked(true);
    return;
  }

  const phase = view.snapshot.phase;
  const sessionOnFeed = isFeedRoute(window.location.href) && (phase === "active" || phase === "paused");
  if (!sessionOnFeed) {
    clearFocusLayer();
    setFeedLocked(phase !== "active");
    return;
  }

  setFeedLocked(false);

  const focusedId = view.snapshot.focusedPostId;
  const handles = adapter.getFeedItems();

  for (const handle of handles) {
    if (focusedId && handle.id === focusedId) {
      handle.element.setAttribute("data-focusdeck-focused", "true");
      handle.element.removeAttribute("data-focusdeck-hidden");
      handle.element.removeAttribute("data-focusdeck-dimmed");
      handle.element.removeAttribute("data-focusdeck-locked");
    } else {
      handle.element.setAttribute("data-focusdeck-hidden", "true");
      handle.element.removeAttribute("data-focusdeck-focused");
      handle.element.removeAttribute("data-focusdeck-dimmed");
      handle.element.removeAttribute("data-focusdeck-locked");
    }
  }
}

async function maybeShowPrompt(): Promise<void> {
  if (!adapter || engine || !isFeedRoute(window.location.href)) {
    return;
  }

  const [config, dailyLimits, dailyUsage] = await Promise.all([getSessionConfig(), getDailyLimits(), getDailyUsage()]);
  applyThemeModeFromConfig(config);

  if (postLimitExploreMode) {
    setFeedLocked(false);
    setAuxiliaryUiHidden(true);
    ensureOverlay().setPromptVisible(false);
    schedulePostLimitEnforcement();
    return;
  }

  siteSettings = siteSettings ?? (await getSiteSettings(adapter.id));
  if (!siteSettings.enabled) {
    setFeedLocked(false);
    setAuxiliaryUiHidden(false);
    ensureOverlay().setPromptPostLimitCap(null);
    ensureOverlay().setDailyLimitReached(false);
    return;
  }

  if (isDailyLimitReached(dailyLimits, dailyUsage, adapter.id)) {
    ensureOverlay().setPromptVisible(false);
    ensureOverlay().setPromptPostLimitCap(null);
    showDailyLimitModal(dailyUsage);
    setAuxiliaryUiHidden(true);
    setFeedLocked(true);
    return;
  }

  const remainingPosts =
    dailyLimits.global.maxPosts > 0 ? Math.max(0, dailyLimits.global.maxPosts - dailyUsage.global.postsViewed) : null;

  setAuxiliaryUiHidden(true);
  setFeedLocked(true);
  ensureOverlay().setDailyLimitReached(false);
  ensureOverlay().setPromptPostLimitCap(remainingPosts);
  ensureOverlay().setPromptVisible(true);
}

async function startSession(overrides: Partial<SessionConfig> = {}, resumeSnapshot?: SessionSnapshot | null): Promise<boolean> {
  if (!adapter) {
    return false;
  }

  ensureFocusLayerStyle();
  const overlayRef = ensureOverlay();
  const [baseConfig, dailyLimits, dailyUsage, nextSiteSettings] = await Promise.all([
    getSessionConfig(),
    getDailyLimits(),
    getDailyUsage(),
    getSiteSettings(adapter.id)
  ]);

  siteSettings = nextSiteSettings;

  if (!siteSettings.enabled) {
    setStatus(`FocusDeck is disabled for ${adapter.name}.`);
    return false;
  }

  if (isDailyLimitReached(dailyLimits, dailyUsage, adapter.id)) {
    showDailyLimitModal(dailyUsage);
    return false;
  }

  const resumeConfig = resumeSnapshot?.adapterId === adapter.id ? resumeSnapshot.config : null;
  const nextConfig: SessionConfig = {
    ...(resumeConfig ?? baseConfig),
    ...overrides
  };
  const remainingPosts =
    dailyLimits.global.maxPosts > 0 ? Math.max(0, dailyLimits.global.maxPosts - dailyUsage.global.postsViewed) : 0;
  if (nextConfig.mode === "posts" && dailyLimits.global.maxPosts > 0 && remainingPosts > 0 && nextConfig.postLimit > remainingPosts) {
    nextConfig.postLimit = remainingPosts;
    setStatus(`Total daily limit allows ${remainingPosts} more post${remainingPosts === 1 ? "" : "s"} today.`);
  }
  applyThemeModeFromConfig(nextConfig);
  clearPostLimitExploreMode();

  keyboardCleanup?.();
  keyboardCleanup = null;

  if (engine) {
    await engine.stop("manual");
    engine = null;
  }

  overlayRef.setCompletion(null);
  overlayRef.setDailyLimitReached(false);
  overlayRef.setPromptPostLimitCap(null);
  setOverlaySuppressed(false);
  setAuxiliaryUiHidden(true);
  setFeedLocked(false);

  engine = new DeckEngine(adapter, dispatcher, dailyLimits, dailyUsage, {
    onComplete: (summary) => {
      if (summary.reason === "time-limit") {
        overlayRef.setCompletion(summary);
        return;
      }

      if (summary.reason === "posts-limit") {
        void finishPostLimitSession();
      }
    },
    onDailyLimitReached: () => {
      showDailyLimitModal(engine?.getDailyUsage() ?? null);
      setStatus("Daily limit reached.");
    },
    canCountProgress: () => isFeedRoute(window.location.href) && !isDetailRoute(window.location.href),
    canCountTime: () => isFeedRoute(window.location.href) && !isDetailRoute(window.location.href)
  });

  engine.subscribe((view) => {
    overlayRef.setView(view);
    applyFocusLayer(view);
  });

  const startDeadline = Date.now() + 12_000;
  let started = false;
  let announcedWait = false;
  let attempts = 0;

  while (Date.now() < startDeadline) {
    attempts += 1;
    started = await engine.start(nextConfig, resumeSnapshot);
    if (started) {
      break;
    }

    if (!isFeedRoute(window.location.href)) {
      break;
    }

    if (!announcedWait) {
      setStatus("Waiting for feed to load...", 1000);
      announcedWait = true;
    }

    if (attempts === 6 || attempts === 14 || attempts === 24) {
      adapter.triggerLazyLoad?.();
      setAuxiliaryUiHidden(true);
    }

    await wait(140);
  }

  if (!started) {
    engine = null;
    overlayRef.setView(null);
    if (isFeedRoute(window.location.href)) {
      overlayRef.setPromptVisible(true);
      setAuxiliaryUiHidden(true);
      setFeedLocked(true);
    } else {
      overlayRef.setPromptVisible(false);
      setAuxiliaryUiHidden(false);
      setFeedLocked(false);
    }
    setStatus("Feed is still loading. Keep scrolling and try again in a moment.");
    return false;
  }

  overlayRef.setPromptVisible(false);
  overlayRef.setPromptPostLimitCap(null);

  keyboardCleanup = installKeyboardShortcuts({
    onNext: () => {
      void moveNext();
    },
    onPrevious: () => {
      void movePrevious();
    },
    onBookmark: () => {
      void runAction("bookmark", true);
    },
    onNotInterested: () => {
      void runAction("notInterested", true);
    },
    onOverlayToggle: () => {
      toggleOverlaySuppression();
    }
  });

  return true;
}

async function finishPostLimitSession(): Promise<void> {
  if (!engine) {
    return;
  }

  const currentEngine = engine;
  const viewedProgressKeys = new Set(currentEngine.getViewState()?.snapshot.stats.viewedPostIds ?? []);
  keyboardCleanup?.();
  keyboardCleanup = null;

  await currentEngine.stop("manual");
  if (engine === currentEngine) {
    engine = null;
  }

  clearFocusLayer();
  setAuxiliaryUiHidden(true);
  setFeedLocked(false);
  enablePostLimitExploreMode(viewedProgressKeys);
  clearResumeRecoveryTimers();
  overlay?.setView(null);
  overlay?.setCompletion(null);
  overlay?.setDailyLimitReached(false);
  overlay?.setPromptVisible(false);
  setOverlaySuppressed(false);
  setStatus("Post target reached. Session ended.", 2200);
}

async function stopSession(): Promise<void> {
  keyboardCleanup?.();
  keyboardCleanup = null;

  if (engine) {
    await engine.stop("manual");
    engine = null;
  }

  clearFocusLayer();
  clearPostLimitExploreMode();
  setAuxiliaryUiHidden(isFeedRoute(window.location.href));
  setFeedLocked(true);
  clearResumeRecoveryTimers();
  overlay?.setView(null);
  overlay?.setCompletion(null);
  overlay?.setDailyLimitReached(false);
  setOverlaySuppressed(false);
  await maybeShowPrompt();
}

async function moveNext(): Promise<void> {
  const moved = await engine?.next();
  if (!moved) {
    setStatus("No next post yet.");
  }
}

async function movePrevious(): Promise<void> {
  const moved = await engine?.previous();
  if (!moved) {
    setStatus("No previous post.");
  }
}

async function runAction(action: AdapterAction, userGesture: boolean): Promise<void> {
  if (!engine) {
    return;
  }

  const result = await engine.runAction(action, userGesture);
  if (result.message) {
    setStatus(result.message);
  }
}

function toggleOverlaySuppression(): void {
  if (overlaySuppressed) {
    setOverlaySuppressed(false);
    setStatus("Overlay controls restored.");
    return;
  }

  setOverlaySuppressed(true);
  setStatus("Overlay controls hidden for 3 seconds.");
}

function isFeedRoute(url: string): boolean {
  if (!adapter) {
    return false;
  }

  if (adapter.isFeedPage) {
    return adapter.isFeedPage(url);
  }

  return true;
}

function isDetailRoute(url: string): boolean {
  if (!adapter) {
    return false;
  }

  if (adapter.isDetailPage) {
    return adapter.isDetailPage(url);
  }

  return /\/status\/\d+/i.test(new URL(url).pathname);
}

async function resumeFromRoutePrompt(): Promise<void> {
  if (!engine || engine.getPhase() !== "paused") {
    return;
  }

  const view = engine.getViewState();
  if (view?.snapshot.pauseReason === "limit") {
    showDailyLimitModal(engine.getDailyUsage());
    return;
  }

  await engine.resume();
  const restored = engine.restoreFocus(view?.snapshot.focusedPostId ?? null, false);
  if (!restored) {
    engine.focusNearestToViewportCenter(true, false);
  }
  scheduleResumeFocusRecovery();

  setStatus("Resumed session.", 2000);
}

function registerPostLimitViewportGuard(): void {
  const onViewportChange = () => {
    if (!postLimitExploreMode) {
      return;
    }

    schedulePostLimitEnforcement();
  };

  window.addEventListener("scroll", onViewportChange, { passive: true });
  window.addEventListener("resize", onViewportChange, { passive: true });
}

function registerBlockedPostInteractionGuard(): void {
  const shouldBlock = (target: EventTarget | null): boolean => {
    if (!postLimitExploreMode) {
      return false;
    }

    if (!(target instanceof Element)) {
      return false;
    }

    return Boolean(target.closest("[data-focusdeck-post-limit-blocked='true']"));
  };

  const blockEvent = (event: Event): void => {
    if (!shouldBlock(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  document.addEventListener("click", blockEvent, true);
  document.addEventListener("auxclick", blockEvent, true);
  document.addEventListener("dblclick", blockEvent, true);
  document.addEventListener("contextmenu", blockEvent, true);
}

function registerDetailClickGuard(): void {
  document.addEventListener(
    "click",
    (event) => {
      if (!engine || engine.getPhase() !== "active") {
        return;
      }

      if (event.defaultPrevented) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const detailAnchor = target.closest<HTMLAnchorElement>("a[href*='/status/'], a[href*='/photo/'], a[href*='/video/']");
      if (!detailAnchor) {
        return;
      }

      const targetValue = detailAnchor.target.toLowerCase();
      const opensDifferentContext =
        targetValue !== "" &&
        targetValue !== "_self" &&
        targetValue !== "_top" &&
        targetValue !== "_parent";
      if (opensDifferentContext || detailAnchor.hasAttribute("download")) {
        return;
      }

      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      void engine.pause("details");
      setAuxiliaryUiHidden(false);
      setFeedLocked(false);
    },
    true
  );
}

async function handleRouteChange(): Promise<void> {
  if (!adapter) {
    return;
  }

  const nextRoute = window.location.href;
  if (nextRoute === lastRoute) {
    return;
  }

  const wasFeed = isFeedRoute(lastRoute);
  const nowFeed = isFeedRoute(nextRoute);
  const nowDetail = isDetailRoute(nextRoute);
  lastRoute = nextRoute;

  if (!engine) {
    if (!nowFeed) {
      clearPostLimitExploreMode();
    }

    if (nowFeed) {
      setAuxiliaryUiHidden(true);
      await maybeShowPrompt();
    } else {
      overlay?.setPromptVisible(false);
      setAuxiliaryUiHidden(false);
      setFeedLocked(false);
    }
    return;
  }

  const phase = engine.getPhase();
  if (phase === "active" && nowDetail) {
    await engine.pause("details");
    setStatus("Paused (viewing details).", 1800);
    setAuxiliaryUiHidden(false);
    setFeedLocked(false);
    return;
  }

  if (phase === "active" && !nowFeed) {
    await engine.pause("navigation");
    setAuxiliaryUiHidden(false);
    setFeedLocked(false);
    return;
  }

  if (nowFeed && phase === "paused") {
    const view = engine.getViewState();
    const routePaused =
      engine.hasRoutePause() || view?.snapshot.pauseReason === "details" || view?.snapshot.pauseReason === "navigation";

    if (routePaused) {
      await resumeFromRoutePrompt();
      return;
    }
  }

  if (phase === "active" && wasFeed && nowFeed) {
    engine.focusNearestToViewportCenter(false, false);
    setAuxiliaryUiHidden(true);
    setFeedLocked(false);
    return;
  }

  if (!nowFeed) {
    setAuxiliaryUiHidden(false);
    setFeedLocked(false);
  }
}

function wrapHistoryRouting(): void {
  const marker = "__focusdeckHistoryWrapped";
  const win = window as Window & { [marker]?: boolean };
  if (win[marker]) {
    return;
  }
  win[marker] = true;

  const dispatch = () => {
    void handleRouteChange();
  };

  const rawPushState = history.pushState;
  history.pushState = function pushStateWrapped(
    data: unknown,
    unused: string,
    url?: string | URL | null
  ): void {
    rawPushState.call(history, data, unused, url);
    dispatch();
  };

  const rawReplaceState = history.replaceState;
  history.replaceState = function replaceStateWrapped(
    data: unknown,
    unused: string,
    url?: string | URL | null
  ): void {
    rawReplaceState.call(history, data, unused, url);
    dispatch();
  };

  window.addEventListener("popstate", () => {
    dispatch();
  });
}

function registerMessageHandlers(): void {
  browserApi.runtime.onMessage.addListener((rawMessage: unknown): Promise<RuntimeResponse> | void => {
    const message = rawMessage as RuntimeMessage;

    if (message.type === "focusdeck:start-session") {
      return startSession(message.payload).then((started) => ({ ok: started, data: { started } }));
    }

    if (message.type === "focusdeck:stop-session") {
      return stopSession().then(() => ({ ok: true }));
    }

  });
}

function registerConfigThemeWatcher(): void {
  browserApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    const change = changes[STORAGE_KEYS.sessionConfig];
    if (!change) {
      return;
    }

    const next = change.newValue as SessionConfig | undefined;
    applyThemeModeFromConfig(next ?? null);
  });
}

async function maybeResumeSession(): Promise<void> {
  if (!adapter || !isFeedRoute(window.location.href)) {
    return;
  }

  const snapshot = await getSessionSnapshot();
  if (!snapshot || snapshot.adapterId !== adapter.id) {
    await maybeShowPrompt();
    return;
  }

  const started = await startSession({}, snapshot);
  if (started) {
    setStatus("Resumed session.", 2000);
    return;
  }

  await maybeShowPrompt();
}

async function bootstrap(): Promise<void> {
  if (!adapter) {
    return;
  }

  ensureOverlay();
  ensureFocusLayerStyle();
  ensureFeedMutationObserver();
  registerPostLimitViewportGuard();
  registerBlockedPostInteractionGuard();
  registerDetailClickGuard();
  registerConfigThemeWatcher();
  wrapHistoryRouting();
  registerMessageHandlers();
  applyThemeModeFromConfig(await getSessionConfig());
  setAuxiliaryUiHidden(isFeedRoute(window.location.href));
  setFeedLocked(isFeedRoute(window.location.href));
  await maybeResumeSession();
}

void bootstrap();
