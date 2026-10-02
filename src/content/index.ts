import { XAdapter } from "@/adapters/x-adapter";
import { getXMutationCards, hasXFeedMutation, isXAdUnit, X_FEED_MUTATION_ATTRIBUTES } from "@/adapters/x-dom";
import { AdapterRegistry } from "@/core/adapter-registry";
import { ActionDispatcher } from "@/core/action-dispatcher";
import { isDailyLimitReached, millisecondsUntilMidnight } from "@/core/daily-counter";
import { DeckEngine } from "@/core/deck-engine";
import { resolveSessionStartConfig } from "@/core/session-config";
import { installKeyboardShortcuts } from "@/content/keyboard";
import { OverlayController } from "@/content/overlay/overlay";
import {
  isFollowingBypassActive,
  shouldPauseFollowingBypass,
  shouldResumeFromFollowingBypass,
  shouldSuppressFollowingLimitUi
} from "@/content/following-bypass";
import {
  expandPostLimitViewedKeys,
  isHandleViewedInPostLimit,
  type PostLimitHandleKey
} from "@/content/post-limit-keys";
import {
  resolveVideoPlaybackGuardDecision,
  type VideoPlaybackGuardEvent,
  type VideoPlaybackGuardMutation
} from "@/content/video-playback-guard";
import { browserApi } from "@/shared/browser-polyfill";
import { OVERLAY_HOST_ID, STORAGE_KEYS } from "@/shared/constants";
import {
  getSessionConfig,
  getSiteSettings
} from "@/shared/storage";
import { claimSessionSnapshot, clearOwnedSessionSnapshot, getDailyContext } from "@/shared/runtime-state";
import type { AdapterAction, PostHandle } from "@/types/adapter";
import type { DailyContext, RuntimeMessage, RuntimeResponse, SiteSettings } from "@/types/messages";
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
let resumeRecoveryTimerIds: number[] = [];
let postLimitExploreMode = false;
let recoveredPresentationPostId: string | null = null;
let postLimitViewedProgressKeys = new Set<string>();
let postLimitEnforceRafId = 0;
let lastRoute = window.location.href;
let routeFallbackTimerId: number | null = null;
let feedLocked = false;
let auxiliaryUiHiddenState: boolean | null = null;
let distractingUiHiddenState: boolean | null = null;
let feedMutationObserver: MutationObserver | null = null;
let feedMutationRafId = 0;
let feedMutationPending = false;
let managedFeedActive = false;
let managedFeedContext: Promise<DailyContext> | null = null;
let lastFocusedVideoHydrationPostId: string | null = null;
let idleRouteSyncInFlight = false;
let focusLayerFreezePostId: string | null = null;
let focusLayerFreezeUntil = 0;
let videoPlaybackBypassPostId: string | null = null;
let videoPlaybackBypassUntil = 0;
let popupScrollLocked = false;
let popupScrollUnlock: (() => void) | null = null;
let routeGeneration = 0;
let promptGeneration = 0;
let startGeneration = 0;
let startInFlight: Promise<boolean> | null = null;
let dailyRefreshGeneration = 0;
let midnightTimerId: number | null = null;
// Cards currently allowed to show, keyed to the post identity they had when allowed.
const allowedCardIds = new WeakMap<HTMLElement, string>();

const AD_HIDDEN_ATTR = "data-focusdeck-ad-hidden";
const DISTRACTION_HIDDEN_ATTR = "data-focusdeck-distraction-hidden";
const SCROLL_BLOCK_KEYS = new Set([" ", "Spacebar", "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]);

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
    onOpenPost: () => {
      void openFocusedPostInBackground();
    },
    onDismissDailyLimit: () => {
      void closeFeedTab();
    },
    onOpenSettings: () => {
      void openSettingsPage();
    },
    onBlockingModalVisibilityChange: (visible) => {
      setPopupScrollLocked(visible);
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

function canPresentRecoveredPost(): boolean {
  return Boolean(recoveredPresentationPostId && (engine?.getFocusedPostId() === recoveredPresentationPostId || postLimitExploreMode));
}

function showDailyLimitModal(usage?: DailyUsage | null): void {
  // Let a recovered charge be read once; the paused engine/viewed-only mode still blocks new progress.
  if (canPresentRecoveredPost()) {
    overlay?.setDailyLimitReached(false);
    return;
  }
  if (!isFeedRoute(window.location.href) || !siteSettings?.enabled || shouldSuppressFollowingLimitUi(isFollowingFeedBypassActive())) {
    overlay?.setDailyLimitReached(false);
    return;
  }

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

function clearResumeRecoveryTimers(): void {
  for (const timerId of resumeRecoveryTimerIds) {
    window.clearTimeout(timerId);
  }
  resumeRecoveryTimerIds = [];
}

function isStoredSnapshotResumable(snapshot: SessionSnapshot | null | undefined): snapshot is SessionSnapshot {
  if (!snapshot || snapshot.adapterId !== adapter?.id || (snapshot.phase !== "paused" && snapshot.phase !== "active")) {
    return false;
  }

  return true;
}

async function resumeStoredSession(snapshot?: SessionSnapshot | null): Promise<boolean> {
  const nextSnapshot = snapshot ?? (await claimSessionSnapshot(adapter!.id));
  if (!isStoredSnapshotResumable(nextSnapshot)) {
    return false;
  }

  const started = await startSession({}, nextSnapshot);
  if (started) {
    setStatus("Resumed session.", 2000);
  }
  return started;
}

async function syncFollowingFeedBypassState(): Promise<boolean> {
  if (!adapter) {
    return false;
  }

  const bypassActive = isFollowingFeedBypassActive();
  if (bypassActive) {
    recoveredPresentationPostId = null;
    managedFeedActive = false;
    managedFeedContext = null;
    if (engine && shouldPauseFollowingBypass(engine.getPhase())) {
      await engine.pause("followingBypass");
    }

    clearSessionKeyboardShortcuts();
    clearResumeRecoveryTimers();
    clearFocusLayer();
    clearPostLimitBlockedMarkers();
    hideOverlaySessionUi();
    setAuxiliaryUiHidden(false);
    setFeedLocked(false);
    return true;
  }

  const managedFeed = isFeedRoute(window.location.href) && siteSettings?.enabled === true;
  if (managedFeed && !managedFeedActive) {
    setFeedLocked(true, true);
    if (engine) managedFeedContext = getDailyContext();
  }
  managedFeedActive = managedFeed;
  if (!managedFeed) managedFeedContext = null;

  if (engine && managedFeed && (managedFeedContext || engine.getPauseReason() === "limit")) {
    const currentEngine = engine;
    const pendingContext = managedFeedContext ?? getDailyContext();
    const context = await pendingContext;
    if (engine !== currentEngine || !isFeedRoute(window.location.href) || isFollowingFeedBypassActive()) return false;
    if (managedFeedContext === pendingContext) managedFeedContext = null;
    currentEngine.setDailyContext(context.limits, context.usage);
    const reached = isDailyLimitReached(context.limits, context.usage, adapter.id);
    overlay?.setDailyLimitReached(reached && !canPresentRecoveredPost());
    if (reached) showDailyLimitModal(context.usage);
    else if (currentEngine.getPauseReason() === "limit") await currentEngine.resume();
  }

  if (
    engine &&
    isFeedRoute(window.location.href) &&
    (shouldResumeFromFollowingBypass(engine.getPhase(), engine.getPauseReason()) || engine.hasRoutePause() ||
      ["details", "navigation"].includes(engine.getPauseReason() ?? ""))
  ) {
    const currentEngine = engine;
    installSessionKeyboardShortcuts();
    await currentEngine.resume();
    const view = currentEngine.getViewState();
    const restored = await currentEngine.restoreFocus(view?.snapshot.focusedPostId ?? null, false);
    if (!restored) {
      await currentEngine.focusNearestToViewportCenter(true);
    }
    if (engine !== currentEngine || !isFeedRoute(window.location.href) || isFollowingFeedBypassActive()) {
      return false;
    }
    scheduleResumeFocusRecovery();
    applyFocusLayer(currentEngine.getViewState());
    setStatus("Resumed session.", 2000);
    return false;
  }

  if (postLimitExploreMode) {
    schedulePostLimitEnforcement();
  }

  return false;
}

function scheduleResumeFocusRecovery(): void {
  clearResumeRecoveryTimers();
  const delays = [0, 120, 300, 650, 1100, 1700];

  for (const delay of delays) {
    const timerId = window.setTimeout(async () => {
      if (!engine || engine.getPhase() !== "active" || !isFeedRoute(window.location.href)) {
        return;
      }

      const current = engine.getViewState();
      if (current?.focusedHandle) {
        applyFocusLayer(current);
        return;
      }

      const currentEngine = engine;
      await currentEngine.focusNearestToViewportCenter(true);
      const recovered = engine === currentEngine ? currentEngine.getViewState() : null;
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

    [${AD_HIDDEN_ATTR}='true'] {
      display: none !important;
    }

    [${DISTRACTION_HIDDEN_ATTR}='true'] {
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
      background:
        repeating-linear-gradient(
          135deg,
          rgba(120, 128, 168, 0.1) 0 1px,
          transparent 1px 9px
        ),
        rgba(120, 128, 168, 0.06) !important;
      z-index: 4 !important;
      pointer-events: auto !important;
    }

    [data-focusdeck-post-limit-blocked='true']::after {
      content: "Session target reached. Scroll up to revisit viewed posts." !important;
      position: absolute !important;
      left: 50% !important;
      top: 50% !important;
      transform: translate(-50%, -50%) !important;
      z-index: 5 !important;
      width: max-content !important;
      max-width: calc(100% - 32px) !important;
      color: #eceefe !important;
      background: #1b1e3a !important;
      border-radius: 10px !important;
      padding: 7px 12px !important;
      font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      text-align: center !important;
      pointer-events: none !important;
    }

    [data-focusdeck-focused='true'] {
      visibility: visible !important;
      opacity: 1 !important;
      filter: none !important;
      outline: none !important;
      position: relative !important;
      border-radius: 16px !important;
      box-shadow: inset 0 0 0 2px rgba(83, 99, 230, 0.9) !important;
      pointer-events: auto !important;
      transition: opacity 120ms ease;
    }

    [data-focusdeck-dimmed='true'] {
      visibility: visible !important;
      opacity: 0.38 !important;
      filter: saturate(0.75) !important;
      pointer-events: none !important;
      transition: opacity 120ms ease;
    }
  `;
  document.head.append(style);
}

function clearFocusLayer(): void {
  feedLocked = false;
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
  clearPostLimitBlockedMarkers();
}

function clearPostLimitBlockedMarkers(): void {
  document.querySelectorAll<HTMLElement>("[data-focusdeck-post-limit-blocked='true']").forEach((node) => {
    node.removeAttribute("data-focusdeck-post-limit-blocked");
    (node as HTMLElement & { inert?: boolean }).inert = false;
  });
}

function enforcePostLimitExploreMode(): void {
  if (!postLimitExploreMode || !adapter || !isFeedRoute(window.location.href) || isFollowingFeedBypassActive()) {
    return;
  }

  for (const handle of adapter.getFeedItems()) {
    applyPostLimitStateForHandle(handle);
  }
}

function applyPostLimitStateForHandle(handle: PostHandle): boolean {
  const progressKey = adapter?.getProgressKey ? adapter.getProgressKey(handle) : handle.id;
  const viewed = isHandleViewedInPostLimit(postLimitViewedProgressKeys, handle.id, progressKey);

  if (viewed) {
    handle.element.removeAttribute("data-focusdeck-post-limit-blocked");
    (handle.element as HTMLElement & { inert?: boolean }).inert = false;
    allowedCardIds.set(handle.element, handle.id);

    // Keep both key forms for viewed posts so DOM key transitions remain playable.
    postLimitViewedProgressKeys.add(handle.id);
    if (progressKey) {
      postLimitViewedProgressKeys.add(progressKey);
    }

    return false;
  }

  handle.element.setAttribute("data-focusdeck-post-limit-blocked", "true");
  (handle.element as HTMLElement & { inert?: boolean }).inert = true;
  allowedCardIds.delete(handle.element);
  return true;
}

function schedulePostLimitEnforcement(): void {
  if (!postLimitExploreMode || postLimitEnforceRafId || isFollowingFeedBypassActive()) {
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
  const currentHandleKeys: PostLimitHandleKey[] = adapter.getFeedItems().map((handle) => ({
    handleId: handle.id,
    progressKey: adapter.getProgressKey ? adapter.getProgressKey(handle) : handle.id
  }));
  postLimitViewedProgressKeys = expandPostLimitViewedKeys(new Set(viewedProgressKeys), currentHandleKeys);
  enforcePostLimitExploreMode();
}

function clearSessionKeyboardShortcuts(): void {
  keyboardCleanup?.();
  keyboardCleanup = null;
}

function installSessionKeyboardShortcuts(): void {
  if (keyboardCleanup) {
    return;
  }

  keyboardCleanup = installKeyboardShortcuts({
    isActive: () => engine?.getPhase() === "active" && isFeedRoute(window.location.href) && !isFollowingFeedBypassActive() && !popupScrollLocked,
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
    onOpenPost: () => {
      void openFocusedPostInBackground();
    }
  });
}

function hideOverlaySessionUi(): void {
  overlay?.setView(null);
  overlay?.setPromptVisible(false);
  overlay?.setPromptPostLimitCap(null);
  overlay?.setDailyLimitReached(false);
}

function isFollowingFeedBypassActive(): boolean {
  return isFollowingBypassActive(siteSettings, Boolean(adapter) && isFeedRoute(window.location.href));
}

function setFeedLocked(locked: boolean, force = false, feedItems?: PostHandle[]): void {
  if (!adapter) {
    return;
  }

  const shouldLock = locked && isFeedRoute(window.location.href);
  if (!force && feedLocked === shouldLock) {
    return;
  }

  feedLocked = shouldLock;

  for (const handle of feedItems ?? adapter.getFeedItems()) {
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

function isAdCell(cell: HTMLElement): boolean {
  return isXAdUnit(cell);
}

function isInputLikeElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function setPopupScrollLocked(locked: boolean): void {
  if (popupScrollLocked === locked) {
    return;
  }

  popupScrollLocked = locked;

  if (!locked) {
    popupScrollUnlock?.();
    popupScrollUnlock = null;
    return;
  }

  const htmlElement = document.documentElement;
  const bodyElement = document.body;

  const previous = {
    htmlOverflow: htmlElement.style.overflow,
    htmlOverscrollBehavior: htmlElement.style.overscrollBehavior,
    bodyOverflow: bodyElement?.style.overflow ?? "",
    bodyOverscrollBehavior: bodyElement?.style.overscrollBehavior ?? ""
  };

  htmlElement.style.overflow = "hidden";
  htmlElement.style.overscrollBehavior = "none";

  if (bodyElement) {
    bodyElement.style.overflow = "hidden";
    bodyElement.style.overscrollBehavior = "none";
  }

  const blockScrollEvent = (event: Event): void => {
    // A modal taller than the viewport scrolls internally (it uses overscroll containment).
    const insideModal = event
      .composedPath()
      .some((node) => node instanceof HTMLElement && node.classList.contains("fd-modal"));
    if (insideModal) {
      return;
    }

    event.preventDefault();
  };
  const blockScrollKey = (event: KeyboardEvent): void => {
    if (!SCROLL_BLOCK_KEYS.has(event.key)) {
      return;
    }

    // Let overlay controls (custom target input, Space on buttons) handle their own keys.
    const path = event.composedPath();
    const fromOverlay = path.some((node) => node instanceof HTMLElement && node.id === OVERLAY_HOST_ID);
    if (fromOverlay || isInputLikeElement(path[0] ?? event.target)) {
      return;
    }

    event.preventDefault();
  };

  document.addEventListener("wheel", blockScrollEvent, { capture: true, passive: false });
  document.addEventListener("touchmove", blockScrollEvent, { capture: true, passive: false });
  document.addEventListener("keydown", blockScrollKey, true);

  popupScrollUnlock = () => {
    document.removeEventListener("wheel", blockScrollEvent, true);
    document.removeEventListener("touchmove", blockScrollEvent, true);
    document.removeEventListener("keydown", blockScrollKey, true);

    htmlElement.style.overflow = previous.htmlOverflow;
    htmlElement.style.overscrollBehavior = previous.htmlOverscrollBehavior;

    if (bodyElement) {
      bodyElement.style.overflow = previous.bodyOverflow;
      bodyElement.style.overscrollBehavior = previous.bodyOverscrollBehavior;
    }
  };
}

function setAdUnitsHidden(force = false): void {
  if (!force && !document.body) {
    return;
  }

  document.querySelectorAll<HTMLElement>(`[${AD_HIDDEN_ATTR}='true']`).forEach((node) => {
    node.removeAttribute(AD_HIDDEN_ATTR);
  });

  const adContainerSelectors = "[data-testid='cellInnerDiv'], [data-testid='placementTracking']";
  document.querySelectorAll<HTMLElement>(adContainerSelectors).forEach((cell) => {
    if (isAdCell(cell)) {
      cell.setAttribute(AD_HIDDEN_ATTR, "true");
    }
  });

  const tweetSelectors = "article[data-testid='tweet'], article[role='article']";
  document.querySelectorAll<HTMLElement>(tweetSelectors).forEach((article) => {
    if (!isAdCell(article)) {
      return;
    }

    const container =
      article.closest<HTMLElement>("[data-testid='cellInnerDiv'], [data-testid='placementTracking']") ?? article;
    container.setAttribute(AD_HIDDEN_ATTR, "true");
  });
}

function normalizeUiText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function shouldHideDistractingElements(): boolean {
  return Boolean(siteSettings?.hideDistractingElements);
}

function clearDistractingUiHiddenMarkers(): void {
  document.querySelectorAll<HTMLElement>(`[${DISTRACTION_HIDDEN_ATTR}='true']`).forEach((node) => {
    node.removeAttribute(DISTRACTION_HIDDEN_ATTR);
  });
}

function findRightRailSearchBranch(rail: HTMLElement): HTMLElement | null {
  const searchNode =
    rail.querySelector<HTMLElement>("form[role='search']") ??
    rail.querySelector<HTMLElement>("[role='search']") ??
    rail.querySelector<HTMLElement>("[data-testid='SearchBox_Search_Input']") ??
    rail.querySelector<HTMLElement>("input[aria-label*='Search']") ??
    rail.querySelector<HTMLElement>("input[placeholder='Search']");

  if (!searchNode) {
    return null;
  }

  return searchNode.closest<HTMLElement>("form[role='search'], [role='search']") ?? searchNode.closest<HTMLElement>("div") ?? searchNode;
}

function hideSiblingBranchesAlongPath(node: HTMLElement, stop: HTMLElement): void {
  let current: HTMLElement | null = node;

  while (current && current !== stop) {
    const containerParent: HTMLElement | null = current.parentElement;
    if (!containerParent) {
      break;
    }

    Array.from(containerParent.children).forEach((child) => {
      if (child instanceof HTMLElement && child !== current) {
        child.setAttribute(DISTRACTION_HIDDEN_ATTR, "true");
      }
    });

    current = containerParent;
  }
}

function hideRightRailDistractions(): void {
  const rails = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='sidebarColumn'], aside[role='complementary']"));

  for (const rail of rails) {
    const searchBranch = findRightRailSearchBranch(rail);
    if (!searchBranch) {
      continue;
    }

    hideSiblingBranchesAlongPath(searchBranch, rail);
  }
}

function isDistractingLeftNavLink(link: HTMLAnchorElement): boolean {
  if (!link.closest("header[role='banner'], nav[role='navigation'], nav[aria-label]")) {
    return false;
  }

  const href = (link.getAttribute("href") ?? "").toLowerCase();
  const text = normalizeUiText(link.textContent ?? "");
  const aria = normalizeUiText(link.getAttribute("aria-label") ?? "");

  if (href === "/explore" || href.startsWith("/explore?")) {
    return true;
  }

  if (href.includes("/connect_people")) {
    return true;
  }

  if (href === "/premium" || href.startsWith("/premium?") || href.includes("premium_sign_up")) {
    return true;
  }

  return text === "explore" || aria === "explore" || text === "follow" || aria === "follow" || text === "premium" || aria === "premium";
}

function hideLeftNavDistractions(): void {
  document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
    if (!isDistractingLeftNavLink(link)) {
      return;
    }

    link.setAttribute(DISTRACTION_HIDDEN_ATTR, "true");
  });
}

function setDistractingUiHidden(hidden: boolean, force = false): void {
  if (!force && distractingUiHiddenState === hidden) {
    return;
  }

  distractingUiHiddenState = hidden;
  clearDistractingUiHiddenMarkers();

  if (!hidden) {
    return;
  }

  hideRightRailDistractions();
  hideLeftNavDistractions();
}

function setAuxiliaryUiHidden(hidden: boolean, force = false, feedItems?: PostHandle[]): void {
  if (!force && auxiliaryUiHiddenState === hidden) {
    return;
  }
  auxiliaryUiHiddenState = hidden;

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

  const knownFeedArticles = new Set<HTMLElement>((feedItems ?? adapter?.getFeedItems() ?? []).map((handle) => handle.element));
  const hasKnownFeedPosts = knownFeedArticles.size > 0;

  const feedCells = Array.from(
    document.querySelectorAll<HTMLElement>("main [data-testid='cellInnerDiv'], main [data-testid='placementTracking']")
  );

  for (const cell of feedCells) {
    const articles = Array.from(cell.querySelectorAll<HTMLElement>("article[data-testid='tweet'], article[role='article']"));
    const hasArticle = articles.length > 0;
    const isKnownPost = articles.some((article) => knownFeedArticles.has(article));
    const hideAsNonFeedArticle = hasKnownFeedPosts && hasArticle && !isKnownPost;
    const hideAsPromotedModule = hasKnownFeedPosts && !hasArticle && cell.matches("[data-testid='placementTracking']");

    if (hideAsNonFeedArticle || hideAsPromotedModule) {
      cell.setAttribute("data-focusdeck-hidden-ui", "true");
    }
  }
}

function isAllowedCardUnchanged(card: HTMLElement): boolean {
  const allowedId = allowedCardIds.get(card);
  if (!allowedId || !adapter?.getHandleId) {
    return false;
  }

  const shown = postLimitExploreMode
    ? !card.hasAttribute("data-focusdeck-post-limit-blocked")
    : card.hasAttribute("data-focusdeck-focused");
  return shown && adapter.getHandleId(card) === allowedId;
}

function ensureFeedMutationObserver(): void {
  if (feedMutationObserver) {
    return;
  }

  const target = document.documentElement;

  feedMutationObserver = new MutationObserver((records) => {
    if (!hasXFeedMutation(records)) {
      return;
    }

    // Only touched cards need synchronous safety; broad reconciliation runs once per frame.
    if (isFeedRoute(window.location.href) && !isFollowingFeedBypassActive()) {
      if (!managedFeedActive && !feedLocked) setFeedLocked(true, true);
      for (const card of getXMutationCards(records)) {
        // A shown post's own player and controls mutate constantly; re-gate it only once it holds another post.
        if (isAllowedCardUnchanged(card)) continue;
        if (postLimitExploreMode) {
          card.setAttribute("data-focusdeck-post-limit-blocked", "true");
          (card as HTMLElement & { inert?: boolean }).inert = true;
        } else {
          card.removeAttribute("data-focusdeck-focused");
          card.setAttribute("data-focusdeck-hidden", "true");
          if (feedLocked || !engine) card.setAttribute("data-focusdeck-locked", "true");
        }
      }
    }
    if (feedMutationRafId) {
      feedMutationPending = true;
      return;
    }

    feedMutationRafId = window.requestAnimationFrame(function reconcile() {
      feedMutationPending = false;
      void (async () => {
        setAdUnitsHidden(true);
        setDistractingUiHidden(shouldHideDistractingElements(), true);

        if (await syncFollowingFeedBypassState()) {
          return;
        }

        const currentEngine = engine;
        let view = currentEngine?.getViewState() ?? null;
        setAuxiliaryUiHidden(postLimitExploreMode ? false : isFeedRoute(window.location.href), true, view?.feedItems);

        if (postLimitExploreMode) {
          enforcePostLimitExploreMode();
          return;
        }

        if (!engine) {
          scheduleIdleRouteSync();
          return;
        }

        if (feedLocked) {
          setFeedLocked(true, true, view?.feedItems);
          return;
        }

        if (!currentEngine) return;
        const focusedRect = view?.focusedHandle?.element.getBoundingClientRect();
        const focusVisible = focusedRect && focusedRect.bottom > 0 && focusedRect.top < window.innerHeight && focusedRect.height > 20;
        if (view?.snapshot.phase === "active" && !focusVisible) {
          await currentEngine.focusNearestToViewportCenter(true);
          view = currentEngine.getViewState();
        }
        if (engine === currentEngine) applyFocusLayer(view);
      })().finally(() => {
        feedMutationRafId = feedMutationPending ? window.requestAnimationFrame(reconcile) : 0;
      });
    });
  });

  feedMutationObserver.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
    attributeFilter: X_FEED_MUTATION_ATTRIBUTES
  });
}

function scheduleIdleRouteSync(): void {
  if (idleRouteSyncInFlight) {
    return;
  }

  idleRouteSyncInFlight = true;
  void (async () => {
    try {
      if (engine || postLimitExploreMode) {
        return;
      }

      setAdUnitsHidden(true);
      setDistractingUiHidden(shouldHideDistractingElements(), true);

      if (await syncFollowingFeedBypassState()) {
        return;
      }

      if (!isFeedRoute(window.location.href)) {
        overlay?.setPromptVisible(false);
        overlay?.setDailyLimitReached(false);
        setAuxiliaryUiHidden(false);
        setFeedLocked(false);
        return;
      }

      if (siteSettings && !siteSettings.enabled) {
        setAuxiliaryUiHidden(false);
        setFeedLocked(false);
        return;
      }

      if (!feedLocked) {
        await maybeShowPrompt();
      }
    } finally {
      idleRouteSyncInFlight = false;
    }
  })();
}

function freezeFocusLayerForPost(postId: string | null, durationMs: number): boolean {
  if (!postId || durationMs <= 0) {
    return false;
  }

  const nextUntil = Math.max(focusLayerFreezeUntil, Date.now() + durationMs);
  const changed = focusLayerFreezePostId !== postId || focusLayerFreezeUntil !== nextUntil;
  focusLayerFreezePostId = postId;
  focusLayerFreezeUntil = nextUntil;
  return changed;
}

function clearFocusLayerFreezeForPost(postId: string | null): boolean {
  if (!postId || focusLayerFreezePostId !== postId) {
    return false;
  }

  const changed = focusLayerFreezePostId !== null || focusLayerFreezeUntil !== 0;
  focusLayerFreezePostId = null;
  focusLayerFreezeUntil = 0;
  return changed;
}

function enableVideoPlaybackBypass(postId: string | null, durationMs: number): boolean {
  if (!postId || durationMs <= 0) {
    return false;
  }

  const nextUntil = Math.max(videoPlaybackBypassUntil, Date.now() + durationMs);
  const changed = videoPlaybackBypassPostId !== postId || videoPlaybackBypassUntil !== nextUntil;
  videoPlaybackBypassPostId = postId;
  videoPlaybackBypassUntil = nextUntil;
  return changed;
}

function clearVideoPlaybackBypass(postId: string | null): boolean {
  if (!postId || videoPlaybackBypassPostId !== postId) {
    return false;
  }

  const changed = videoPlaybackBypassPostId !== null || videoPlaybackBypassUntil !== 0;
  videoPlaybackBypassPostId = null;
  videoPlaybackBypassUntil = 0;
  return changed;
}

function applyVideoPlaybackMutation(
  postId: string | null,
  mutation: VideoPlaybackGuardMutation,
  onSet: (postId: string | null, durationMs: number) => boolean,
  onClear: (postId: string | null) => boolean
): boolean {
  if (mutation.mode === "set") {
    return onSet(postId, mutation.durationMs);
  }

  if (mutation.mode === "clear") {
    return onClear(postId);
  }

  return false;
}

function createPlaybackFocusLayerSync(): { syncNow: () => void; syncSoon: () => void } {
  let rafId = 0;

  const sync = async (): Promise<void> => {
    if (!engine || engine.getPhase() !== "active") {
      return;
    }

    const currentEngine = engine;
    let view = currentEngine.getViewState();
    if (view?.snapshot.phase === "active" && !view.focusedHandle) {
      await currentEngine.focusNearestToViewportCenter(true);
      view = engine === currentEngine ? currentEngine.getViewState() : null;
      if (!view?.focusedHandle) {
        return;
      }
    }

    applyFocusLayer(view);
  };

  const syncNow = (): void => {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }

    void sync();
  };

  const syncSoon = (): void => {
    if (rafId) {
      return;
    }

    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      void sync();
    });
  };

  return { syncNow, syncSoon };
}

function applyFocusLayer(view: ReturnType<DeckEngine["getViewState"]>): void {
  if (!adapter) {
    lastFocusedVideoHydrationPostId = null;
    clearFocusLayerFreezeForPost(focusLayerFreezePostId);
    clearVideoPlaybackBypass(videoPlaybackBypassPostId);
    clearFocusLayer();
    return;
  }

  if (isFollowingFeedBypassActive()) {
    lastFocusedVideoHydrationPostId = null;
    clearFocusLayerFreezeForPost(focusLayerFreezePostId);
    clearVideoPlaybackBypass(videoPlaybackBypassPostId);
    clearFocusLayer();
    clearPostLimitBlockedMarkers();
    setFeedLocked(false);
    setAuxiliaryUiHidden(false);
    return;
  }

  if (!isFeedRoute(window.location.href)) {
    lastFocusedVideoHydrationPostId = null;
    clearFocusLayerFreezeForPost(focusLayerFreezePostId);
    clearVideoPlaybackBypass(videoPlaybackBypassPostId);
    clearFocusLayer();
    setFeedLocked(false);
    setAuxiliaryUiHidden(false);
    return;
  }

  setAuxiliaryUiHidden(isFeedRoute(window.location.href));

  if (!view) {
    lastFocusedVideoHydrationPostId = null;
    clearFocusLayerFreezeForPost(focusLayerFreezePostId);
    clearVideoPlaybackBypass(videoPlaybackBypassPostId);
    clearFocusLayer();
    setFeedLocked(true);
    return;
  }

  const phase = view.snapshot.phase;
  const sessionOnFeed = isFeedRoute(window.location.href) && (phase === "active" || phase === "paused");
  if (!sessionOnFeed) {
    lastFocusedVideoHydrationPostId = null;
    clearFocusLayerFreezeForPost(focusLayerFreezePostId);
    clearVideoPlaybackBypass(videoPlaybackBypassPostId);
    clearFocusLayer();
    setFeedLocked(phase !== "active");
    return;
  }

  const focusedId = view.snapshot.focusedPostId;
  if (!focusedId) {
    lastFocusedVideoHydrationPostId = null;
    clearFocusLayerFreezeForPost(focusLayerFreezePostId);
    clearVideoPlaybackBypass(videoPlaybackBypassPostId);
    clearFocusLayer();
    setFeedLocked(true);
    return;
  }

  if (focusLayerFreezePostId && focusLayerFreezePostId !== focusedId) {
    clearFocusLayerFreezeForPost(focusLayerFreezePostId);
  }
  if (videoPlaybackBypassPostId && videoPlaybackBypassPostId !== focusedId) {
    clearVideoPlaybackBypass(videoPlaybackBypassPostId);
  }

  setFeedLocked(false);
  const handles = view.feedItems;
  for (const handle of handles) {
    if (handle.element === view.focusedHandle?.element && handle.id === focusedId) {
      allowedCardIds.set(handle.element, handle.id);
      if (!handle.element.hasAttribute("data-focusdeck-focused")) {
        handle.element.setAttribute("data-focusdeck-focused", "true");
      }
      if (handle.element.hasAttribute("data-focusdeck-hidden")) {
        handle.element.removeAttribute("data-focusdeck-hidden");
      }
      if (handle.element.hasAttribute("data-focusdeck-dimmed")) {
        handle.element.removeAttribute("data-focusdeck-dimmed");
      }
      if (handle.element.hasAttribute("data-focusdeck-locked")) {
        handle.element.removeAttribute("data-focusdeck-locked");
      }
    } else {
      allowedCardIds.delete(handle.element);
      if (!handle.element.hasAttribute("data-focusdeck-hidden")) {
        handle.element.setAttribute("data-focusdeck-hidden", "true");
      }
      if (handle.element.hasAttribute("data-focusdeck-focused")) {
        handle.element.removeAttribute("data-focusdeck-focused");
      }
      if (handle.element.hasAttribute("data-focusdeck-dimmed")) {
        handle.element.removeAttribute("data-focusdeck-dimmed");
      }
      if (handle.element.hasAttribute("data-focusdeck-locked")) {
        handle.element.removeAttribute("data-focusdeck-locked");
      }
    }
  }

  hydrateFocusedPostVideos(view.focusedHandle?.element ?? null, focusedId);
}

function hydrateFocusedPostVideos(focusedElement: HTMLElement | null, focusedPostId: string | null): void {
  if (!focusedElement || !focusedPostId) {
    lastFocusedVideoHydrationPostId = null;
    return;
  }

  const videos = Array.from(focusedElement.querySelectorAll<HTMLVideoElement>("video"));
  if (!videos.length) {
    lastFocusedVideoHydrationPostId = focusedPostId;
    return;
  }

  for (const video of videos) {
    if (video.preload === "" || video.preload === "none" || video.preload === "metadata") {
      video.preload = "auto";
    }
    video.playsInline = true;
    video.setAttribute("playsinline", "");
  }

  lastFocusedVideoHydrationPostId = focusedPostId;
}

function registerVideoPlaybackStabilityGuard(): void {
  const focusLayerSync = createPlaybackFocusLayerSync();
  const videoSurfaceSelector =
    "video, [data-testid='videoComponent'], [data-testid='videoPlayer'], [data-testid*='video'], [data-testid*='play'], [aria-label*='Play'], [aria-label*='play'], [aria-label*='Pause'], [aria-label*='pause']";
  let lastFocusedVideoInteractionPostId: string | null = null;
  let lastFocusedVideoInteractionAt = 0;

  const isMediaGuardEvent = (eventType: VideoPlaybackGuardEvent): boolean => {
    return eventType === "play" || eventType === "playing" || eventType === "waiting" || eventType === "pause" || eventType === "ended";
  };

  const isTargetInsideFocusedVideo = (
    eventType: VideoPlaybackGuardEvent,
    target: EventTarget | null
  ): { postId: string | null; matched: boolean } => {
    if (!(target instanceof Element) || !engine || engine.getPhase() !== "active") {
      return { postId: null, matched: false };
    }

    const view = engine.getViewState();
    const focusedId = view?.snapshot.focusedPostId ?? null;
    const focusedElement = view?.focusedHandle?.element ?? null;
    if (!focusedId || !focusedElement) {
      return { postId: null, matched: false };
    }

    const videoSurface = target.closest<HTMLElement>(videoSurfaceSelector);
    if (!videoSurface || !focusedElement.contains(videoSurface)) {
      const insideFocused = focusedElement.contains(target);
      if (insideFocused && focusedElement.querySelector("video")) {
        return { postId: focusedId, matched: true };
      }

      if (
        isMediaGuardEvent(eventType) &&
        lastFocusedVideoInteractionPostId === focusedId &&
        Date.now() - lastFocusedVideoInteractionAt <= 3_000
      ) {
        return { postId: focusedId, matched: true };
      }

      return { postId: null, matched: false };
    }

    return { postId: focusedId, matched: true };
  };

  const handlePlaybackGuardEvent = (eventType: VideoPlaybackGuardEvent, target: EventTarget | null): void => {
    const { postId, matched } = isTargetInsideFocusedVideo(eventType, target);
    if (matched && (eventType === "pointerdown" || eventType === "click")) {
      lastFocusedVideoInteractionPostId = postId;
      lastFocusedVideoInteractionAt = Date.now();
    }

    const decision = resolveVideoPlaybackGuardDecision({
      eventType,
      matchedFocusedVideo: matched,
      mediaEnded: target instanceof HTMLMediaElement && target.ended
    });
    if (decision.syncMode === "none") {
      return;
    }

    const freezeChanged = applyVideoPlaybackMutation(
      postId,
      decision.freeze,
      freezeFocusLayerForPost,
      clearFocusLayerFreezeForPost
    );
    const bypassChanged = applyVideoPlaybackMutation(
      postId,
      decision.bypass,
      enableVideoPlaybackBypass,
      clearVideoPlaybackBypass
    );
    if (!freezeChanged && !bypassChanged) {
      return;
    }

    if (decision.syncMode === "now") {
      focusLayerSync.syncNow();
      return;
    }

    focusLayerSync.syncSoon();
  };

  document.addEventListener("pointerdown", (event) => {
    handlePlaybackGuardEvent("pointerdown", event.target);
  }, true);

  document.addEventListener("click", (event) => {
    handlePlaybackGuardEvent("click", event.target);
  }, true);

  document.addEventListener("play", (event) => {
    handlePlaybackGuardEvent("play", event.target);
  }, true);

  document.addEventListener("playing", (event) => {
    handlePlaybackGuardEvent("playing", event.target);
  }, true);

  document.addEventListener("waiting", (event) => {
    handlePlaybackGuardEvent("waiting", event.target);
  }, true);

  document.addEventListener("pause", (event) => {
    handlePlaybackGuardEvent("pause", event.target);
  }, true);

  document.addEventListener("ended", (event) => {
    handlePlaybackGuardEvent("ended", event.target);
  }, true);
}

async function maybeShowPrompt(): Promise<void> {
  if (!adapter || engine || !isFeedRoute(window.location.href)) {
    return;
  }

  const generation = ++promptGeneration;
  const route = routeGeneration;
  const isCurrent = () => generation === promptGeneration && route === routeGeneration && !engine &&
    isFeedRoute(window.location.href) && !isFollowingFeedBypassActive();
  setAdUnitsHidden(true);
  siteSettings = siteSettings ?? (await getSiteSettings(adapter.id));
  if (!isCurrent()) {
    return;
  }
  setDistractingUiHidden(shouldHideDistractingElements(), true);

  if (await syncFollowingFeedBypassState()) {
    return;
  }

  if (!siteSettings.enabled) {
    hideOverlaySessionUi();
    setFeedLocked(false);
    setAuxiliaryUiHidden(false);
    return;
  }

  if (await resumeStoredSession()) {
    return;
  }

  const [config, context] = await Promise.all([getSessionConfig(), getDailyContext()]);
  if (!isCurrent() || !siteSettings?.enabled) {
    return;
  }
  const { limits: dailyLimits, usage: dailyUsage } = context;
  applyThemeModeFromConfig(config);

  if (postLimitExploreMode) {
    setFeedLocked(false);
    setAuxiliaryUiHidden(false);
    ensureOverlay().setPromptVisible(false);
    schedulePostLimitEnforcement();
    return;
  }

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
  if (startInFlight) {
    return startInFlight;
  }
  const generation = ++startGeneration;
  startInFlight = runSessionStart(overrides, resumeSnapshot, generation);
  try {
    return await startInFlight;
  } finally {
    startInFlight = null;
  }
}

async function runSessionStart(overrides: Partial<SessionConfig>, resumeSnapshot: SessionSnapshot | null | undefined, generation: number): Promise<boolean> {
  const route = routeGeneration;
  const isCurrent = () => generation === startGeneration && route === routeGeneration && isFeedRoute(window.location.href);
  if (!adapter || !isCurrent()) {
    return false;
  }

  ensureFocusLayerStyle();
  const overlayRef = ensureOverlay();
  const [baseConfig, context, nextSiteSettings] = await Promise.all([
    getSessionConfig(), getDailyContext(), getSiteSettings(adapter.id)
  ]);
  if (!isCurrent()) {
    return false;
  }
  const { limits: dailyLimits, usage: dailyUsage } = context;
  siteSettings = nextSiteSettings;

  if (!siteSettings.enabled) {
    setStatus(`FocusDeck is disabled for ${adapter.name}.`);
    return false;
  }

  if (await syncFollowingFeedBypassState()) {
    setStatus("FocusDeck is bypassed on Following.", 1800);
    return false;
  }

  if (!isCurrent()) return false;
  const claimedSnapshot = await claimSessionSnapshot(adapter.id);
  if (!isCurrent()) return false;

  const candidate = resumeSnapshot ?? (engine ? null : claimedSnapshot);
  const resumeForAdapter = isStoredSnapshotResumable(candidate) ? candidate : null;
  const pendingRecovery = resumeForAdapter?.pendingPresentations?.length;
  if (isDailyLimitReached(dailyLimits, dailyUsage, adapter.id) && !pendingRecovery) {
    showDailyLimitModal(dailyUsage);
    return false;
  }

  const resolved = resolveSessionStartConfig(baseConfig, overrides, resumeForAdapter, dailyLimits, dailyUsage);
  const nextConfig = resolved.config;

  if (resolved.cappedByDailyLimit && resolved.remainingPosts !== null) {
    const remainingPosts = resolved.remainingPosts;
    setStatus(`Total daily limit allows ${remainingPosts} more post${remainingPosts === 1 ? "" : "s"} today.`);
  }

  applyThemeModeFromConfig(nextConfig);
  clearPostLimitExploreMode();

  keyboardCleanup?.();
  keyboardCleanup = null;

  if (engine) {
    const currentEngine = engine;
    engine = null;
    await currentEngine.stop("manual");
  }
  if (!isCurrent()) {
    return false;
  }

  overlayRef.setDailyLimitReached(false);
  overlayRef.setPromptPostLimitCap(null);
  setAuxiliaryUiHidden(true);
  setFeedLocked(true);

  recoveredPresentationPostId = null;
  const localEngine: DeckEngine = new DeckEngine(adapter, dispatcher, dailyLimits, dailyUsage, {
    observeFeed: false,
    reconcileOwnership: (snapshot) => claimSessionSnapshot(adapter.id, snapshot.sessionId),
    onComplete: (summary) => {
      if (summary.reason === "posts-limit") {
        void finishPostLimitSession(localEngine);
      }
    },
    onDailyLimitReached: () => {
      showDailyLimitModal(engine?.getDailyUsage() ?? null);
      setStatus("Daily limit reached.");
    },
    onError: (message) => {
      setStatus(message);
      if (engine === localEngine && !localEngine.getViewState()?.focusedHandle) {
        overlayRef.setPromptVisible(true);
        setFeedLocked(true, true);
      }
    },
    canCountProgress: () => engine === localEngine && isFeedRoute(window.location.href) && siteSettings?.enabled === true && !isFollowingFeedBypassActive()
  });

  engine = localEngine;
  localEngine.subscribe((view) => {
    if (engine !== localEngine) {
      return;
    }
    const focused = view.focusedHandle;
    if (focused && view.snapshot.pendingPresentations?.some((pending) =>
      pending.progressKey === (adapter.getProgressKey ? adapter.getProgressKey(focused) : focused.id))) {
      recoveredPresentationPostId = focused.id;
    }
    overlayRef.setView(view);
    applyFocusLayer(view);
  });

  const startDeadline = Date.now() + 12_000;
  let started = false;
  let announcedWait = false;
  let attempts = 0;

  while (Date.now() < startDeadline && isCurrent() && engine === localEngine && !isFollowingFeedBypassActive()) {
    attempts += 1;
    started = await localEngine.start(nextConfig, resumeForAdapter);
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

  if (!isCurrent() || isFollowingFeedBypassActive()) {
    await localEngine.dispose();
    if (engine === localEngine) {
      engine = null;
    }
    return false;
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

  overlayRef.setPromptVisible(localEngine.getPhase() === "paused" && localEngine.getPauseReason() === "manual" &&
    !localEngine.getViewState()?.focusedHandle);
  overlayRef.setPromptPostLimitCap(null);
  if (engine === localEngine && localEngine.getPhase() === "active") {
    installSessionKeyboardShortcuts();
  }

  return true;
}

async function finishPostLimitSession(completedEngine: DeckEngine): Promise<void> {
  if (engine !== completedEngine) {
    return;
  }

  const currentEngine = engine;
  const viewedProgressKeys = new Set(currentEngine.getViewState()?.snapshot.stats.viewedPostIds ?? []);
  clearSessionKeyboardShortcuts();

  await currentEngine.stop("manual");
  if (engine !== currentEngine) {
    return;
  }
  engine = null;
  if (!isFeedRoute(window.location.href)) {
    return;
  }

  clearFocusLayer();
  setAuxiliaryUiHidden(false);
  setFeedLocked(false);
  enablePostLimitExploreMode(viewedProgressKeys);
  clearResumeRecoveryTimers();
  overlay?.setView(null);
  overlay?.setPromptVisible(false);
  await refreshDailyContext();
  setStatus("Post target reached. Session ended.", 2200);
}

async function stopSession(): Promise<void> {
  recoveredPresentationPostId = null;
  startGeneration += 1;
  promptGeneration += 1;
  clearSessionKeyboardShortcuts();

  if (engine) {
    const currentEngine = engine;
    engine = null;
    await currentEngine.stop("manual");
  }

  clearFocusLayer();
  clearPostLimitExploreMode();
  setAuxiliaryUiHidden(isFeedRoute(window.location.href));
  setFeedLocked(true);
  clearResumeRecoveryTimers();
  overlay?.setView(null);
  overlay?.setDailyLimitReached(false);
  await maybeShowPrompt();
}

async function moveNext(): Promise<void> {
  const moved = await engine?.next();
  if (!moved && engine?.getPhase() === "active") {
    setStatus("No next post yet.");
  }
}

async function movePrevious(): Promise<void> {
  const moved = await engine?.previous();
  if (!moved && engine?.getPhase() === "active") {
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

async function openFocusedPostInBackground(): Promise<void> {
  if (!engine || engine.getPhase() !== "active") {
    setStatus("Start or resume a session first.");
    return;
  }

  const viewState = engine.getViewState();
  const permalink = viewState?.focusedMeta?.permalink ?? (viewState?.focusedHandle ? adapter?.getPermalink?.(viewState.focusedHandle) : null);
  if (!permalink) {
    setStatus("Unable to find this post link.");
    return;
  }

  try {
    const response = (await browserApi.runtime.sendMessage({
      type: "focusdeck:open-background-tab",
      url: permalink
    })) as RuntimeResponse | undefined;

    if (!response?.ok) {
      throw new Error(response?.error || "Failed to open background tab.");
    }

    setStatus("Opened post in background tab.", 1800);
  } catch {
    window.open(permalink, "_blank", "noopener,noreferrer");
    setStatus("Opened post in new tab.", 1800);
  }
}

function isFeedRoute(url: string): boolean {
  if (!adapter) {
    return false;
  }

  if (adapter.isAuthenticated && !adapter.isAuthenticated(url)) {
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

  const currentEngine = engine;
  await currentEngine.resume();
  const restored = await currentEngine.restoreFocus(view?.snapshot.focusedPostId ?? null, false);
  if (!restored) {
    await currentEngine.focusNearestToViewportCenter(true);
  }
  if (engine !== currentEngine) {
    return;
  }
  installSessionKeyboardShortcuts();
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

    if (isFollowingFeedBypassActive()) {
      return false;
    }

    if (!(target instanceof Element)) {
      return false;
    }

    if (!adapter || !isFeedRoute(window.location.href)) {
      return false;
    }

    const handles = adapter.getFeedItems();
    const matchingHandle = handles.find((handle) => handle.element === target || handle.element.contains(target));
    if (matchingHandle) {
      return applyPostLimitStateForHandle(matchingHandle);
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
  document.addEventListener("pointerdown", blockEvent, true);
  document.addEventListener("mousedown", blockEvent, true);
  document.addEventListener("touchstart", blockEvent, true);
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
  routeGeneration += 1;
  startGeneration += 1;
  promptGeneration += 1;
  if (!nowFeed) {
    recoveredPresentationPostId = null;
    hideOverlaySessionUi();
    clearSessionKeyboardShortcuts();
    clearFocusLayer();
    setFeedLocked(false);
  }
  setAdUnitsHidden(true);
  setDistractingUiHidden(shouldHideDistractingElements(), true);

  if (await syncFollowingFeedBypassState()) {
    return;
  }

  if (!engine) {
    if (!nowFeed) {
      clearPostLimitExploreMode();
    }

    if (nowFeed) {
      await refreshDailyContext();
      setAuxiliaryUiHidden(true);
      await maybeShowPrompt();
    } else {
      overlay?.setPromptVisible(false);
      setAuxiliaryUiHidden(false);
      setFeedLocked(false);
    }
    return;
  }

  if (nowFeed) {
    await refreshDailyContext();
  }
  const phase = engine?.getPhase();
  if (!engine) {
    return;
  }
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
    await engine.focusNearestToViewportCenter(false);
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

function registerRouteFallbackWatcher(): void {
  if (routeFallbackTimerId !== null) {
    return;
  }

  routeFallbackTimerId = window.setInterval(() => {
    if (window.location.href === lastRoute) {
      return;
    }

    void handleRouteChange();
  }, 220);
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

async function refreshDailyContext(): Promise<void> {
  if (!adapter) {
    return;
  }
  const generation = ++dailyRefreshGeneration;
  const context = await getDailyContext();
  if (generation !== dailyRefreshGeneration) {
    return;
  }
  engine?.setDailyContext(context.limits, context.usage);
  if (!isFeedRoute(window.location.href) || isFollowingFeedBypassActive() || !siteSettings?.enabled) {
    overlay?.setDailyLimitReached(false);
    return;
  }
  const reached = isDailyLimitReached(context.limits, context.usage, adapter.id);
  if (reached) {
    overlay?.setPromptVisible(false);
    showDailyLimitModal(context.usage);
    if (!engine && !postLimitExploreMode) {
      setFeedLocked(true, true);
    }
  } else {
    overlay?.setDailyLimitReached(false);
    if (engine) {
      await syncFollowingFeedBypassState();
      const view = engine?.getViewState();
      if (view?.snapshot.phase === "paused" && view.snapshot.pauseReason === "limit") {
        await resumeFromRoutePrompt();
      }
      applyFocusLayer(engine?.getViewState() ?? null);
    } else {
      await maybeShowPrompt();
    }
  }
}

function registerDailyRefresh(): void {
  const scheduleMidnight = () => {
    if (midnightTimerId !== null) {
      window.clearTimeout(midnightTimerId);
    }
    midnightTimerId = window.setTimeout(() => {
      void refreshDailyContext().finally(scheduleMidnight);
    }, millisecondsUntilMidnight());
  };
  scheduleMidnight();
  const onActivation = () => {
    if (document.visibilityState === "visible") {
      scheduleMidnight();
      void refreshDailyContext();
    }
  };
  document.addEventListener("visibilitychange", onActivation);
  window.addEventListener("focus", onActivation);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      void engine?.reconcileOwnership().then(() => refreshDailyContext());
    }
  });
}

function registerStorageWatchers(): void {
  browserApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes[STORAGE_KEYS.dailyLimits] || changes[STORAGE_KEYS.dailyUsage]) {
      void refreshDailyContext();
    }

    const sessionConfigChange = changes[STORAGE_KEYS.sessionConfig];
    if (sessionConfigChange) {
      const next = sessionConfigChange.newValue as SessionConfig | undefined;
      applyThemeModeFromConfig(next ?? null);
    }

    if (!adapter || !changes[STORAGE_KEYS.siteSettings]) {
      return;
    }

    void (async () => {
      siteSettings = await getSiteSettings(adapter.id);
      promptGeneration += 1;
      setDistractingUiHidden(shouldHideDistractingElements(), true);

      if (await syncFollowingFeedBypassState()) {
        return;
      }

      if (engine) {
        return;
      }

      if (!isFeedRoute(window.location.href)) {
        overlay?.setPromptVisible(false);
        overlay?.setDailyLimitReached(false);
        setAuxiliaryUiHidden(false);
        setFeedLocked(false);
        return;
      }

      if (!siteSettings.enabled) {
        overlay?.setPromptVisible(false);
        overlay?.setDailyLimitReached(false);
        setAuxiliaryUiHidden(false);
        setFeedLocked(false);
        return;
      }

      await maybeShowPrompt();
    })();
  });
}

async function maybeResumeSession(): Promise<void> {
  if (!adapter || !isFeedRoute(window.location.href)) {
    return;
  }

  const snapshot = await claimSessionSnapshot(adapter!.id);
  if (!snapshot || snapshot.adapterId !== adapter.id) {
    await maybeShowPrompt();
    return;
  }

  if (!isStoredSnapshotResumable(snapshot)) {
    await clearOwnedSessionSnapshot();
    await maybeShowPrompt();
    return;
  }

  if (await syncFollowingFeedBypassState()) {
    return;
  }

  const started = await resumeStoredSession(snapshot);
  if (started) {
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
  setPopupScrollLocked(false);
  setAdUnitsHidden(true);
  ensureFeedMutationObserver();
  registerPostLimitViewportGuard();
  registerBlockedPostInteractionGuard();
  registerVideoPlaybackStabilityGuard();
  registerStorageWatchers();
  registerDailyRefresh();
  wrapHistoryRouting();
  registerRouteFallbackWatcher();
  registerMessageHandlers();
  applyThemeModeFromConfig(await getSessionConfig());
  siteSettings = await getSiteSettings(adapter.id);
  setAdUnitsHidden(true);
  setDistractingUiHidden(shouldHideDistractingElements(), true);
  const bypassActive = await syncFollowingFeedBypassState();
  if (!bypassActive) {
    setAuxiliaryUiHidden(isFeedRoute(window.location.href));
    setFeedLocked(isFeedRoute(window.location.href));
  }
  await maybeResumeSession();
}

void bootstrap();
