import type { AdapterAction } from "@/types/adapter";
import type { DeckViewState } from "@/core/deck-engine";
import type { SessionConfig, SessionSummary, ThemeMode } from "@/types/session";
import { OVERLAY_HOST_ID, OVERLAY_Z_INDEX } from "@/shared/constants";
import overlayStyles from "@/content/overlay/styles.css?inline";

export interface OverlayCallbacks {
  onStartSession: (partial: Partial<SessionConfig>) => void;
  onAction: (action: AdapterAction) => void;
  onDismissComplete: () => void;
  onStartNewSession: () => void;
  onExtendPosts: () => void;
  onExtendMinutes: () => void;
  onDismissDailyLimit: () => void;
  onOpenSettings: () => void;
}

interface PromptState {
  visible: boolean;
  mode: "posts" | "time";
  preset: string;
  customValue: number;
  postLimitCap: number | null;
}

interface OverlayState {
  view: DeckViewState | null;
  themeMode: ThemeMode;
  status: string | null;
  prompt: PromptState;
  completion: SessionSummary | null;
  dailyLimitReached: boolean;
  dailyLimitContext: {
    postsToday: number | null;
    siteLabel: string;
  };
  focusLayerSuppressed: boolean;
}

export class OverlayController {
  private host: HTMLDivElement | null = null;
  private shadow: ShadowRoot | null = null;
  private app: HTMLElement | null = null;

  private readonly state: OverlayState = {
    view: null,
    themeMode: "system",
    status: null,
    prompt: {
      visible: false,
      mode: "posts",
      preset: "10",
      customValue: 10,
      postLimitCap: null
    },
    completion: null,
    dailyLimitReached: false,
    dailyLimitContext: {
      postsToday: null,
      siteLabel: "X"
    },
    focusLayerSuppressed: false
  };

  constructor(private readonly callbacks: OverlayCallbacks) {}

  mount(): void {
    if (this.host) {
      return;
    }

    const host = document.createElement("div");
    host.id = OVERLAY_HOST_ID;
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.zIndex = String(OVERLAY_Z_INDEX);
    host.style.pointerEvents = "none";

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = overlayStyles;

    const app = document.createElement("div");
    app.className = "fd-root";

    shadow.append(style, app);
    document.documentElement.append(host);

    this.host = host;
    this.shadow = shadow;
    this.app = app;
    this.render();
  }

  unmount(): void {
    if (this.host) {
      this.host.remove();
    }

    this.host = null;
    this.shadow = null;
    this.app = null;
  }

  setView(view: DeckViewState | null): void {
    const previousView = this.state.view;
    this.state.view = view;
    if (this.shouldSkipRenderForViewChange(previousView, view)) {
      this.syncFloatingPosition(view);
      return;
    }
    this.render();
  }

  setThemeMode(themeMode: ThemeMode): void {
    this.state.themeMode = themeMode;
    this.render();
  }

  setStatus(message: string | null): void {
    this.state.status = message;
    this.render();
  }

  setPromptVisible(visible: boolean): void {
    this.state.prompt.visible = visible;
    this.render();
  }

  setPromptPostLimitCap(cap: number | null): void {
    this.state.prompt.postLimitCap = typeof cap === "number" && cap > 0 ? Math.floor(cap) : null;
    this.render();
  }

  setCompletion(summary: SessionSummary | null): void {
    this.state.completion = summary;
    this.render();
  }

  setDailyLimitReached(reached: boolean): void {
    this.state.dailyLimitReached = reached;
    this.render();
  }

  setDailyLimitContext(context: { postsToday: number | null; siteLabel: string }): void {
    this.state.dailyLimitContext = context;
    this.render();
  }

  setFocusLayerSuppressed(suppressed: boolean): void {
    this.state.focusLayerSuppressed = suppressed;
    this.render();
  }

  private render(): void {
    if (!this.app) {
      return;
    }

    this.app.className = `fd-root fd-theme-${this.resolveTheme()}`;

    this.app.replaceChildren();

    const stack = document.createElement("div");
    stack.className = "fd-stack";

    if (!this.state.focusLayerSuppressed) {
      const floating = this.renderFloating();
      if (floating) {
        stack.append(floating);
      }
    }

    const prompt = this.renderPrompt();
    if (prompt) {
      stack.append(prompt);
    }

    const status = this.renderStatus();
    if (status) {
      stack.append(status);
    }

    this.app.append(stack);

    const completion = this.renderCompletionModal();
    if (completion) {
      this.app.append(completion);
    }

    const daily = this.renderDailyLimitModal();
    if (daily) {
      this.app.append(daily);
    }
  }

  private shouldSkipRenderForViewChange(previous: DeckViewState | null, next: DeckViewState | null): boolean {
    if (!previous || !next) {
      return false;
    }

    const prev = previous.snapshot;
    const curr = next.snapshot;

    if (prev.phase !== curr.phase) {
      return false;
    }

    if (prev.focusedPostId !== curr.focusedPostId) {
      return false;
    }

    if (prev.pauseReason !== curr.pauseReason) {
      return false;
    }

    if (prev.stats.viewedCount !== curr.stats.viewedCount) {
      return false;
    }

    if (prev.config.minimalMode !== curr.config.minimalMode) {
      return false;
    }

    if (prev.config.mode !== curr.config.mode) {
      return false;
    }

    if (prev.config.postLimit !== curr.config.postLimit) {
      return false;
    }

    if (prev.config.timeLimitMinutes !== curr.config.timeLimitMinutes) {
      return false;
    }

    if (prev.config.themeMode !== curr.config.themeMode) {
      return false;
    }

    return true;
  }

  private syncFloatingPosition(view: DeckViewState | null): void {
    if (!view || !this.app) {
      return;
    }

    const actionPill = this.app.querySelector<HTMLElement>(".fd-action-pill");
    if (!actionPill) {
      return;
    }

    this.positionActionPill(actionPill, view.focusedHandle?.element ?? null);
  }

  private renderFloating(): HTMLElement | null {
    const view = this.state.view;
    if (!view) {
      return null;
    }

    const { snapshot } = view;
    if (snapshot.phase === "idle" || snapshot.phase === "prompting") {
      return null;
    }

    const shell = document.createElement("section");
    shell.className = "fd-floating-layer";

    const progress = document.createElement("aside");
    progress.className = "fd-progress-pill";
    progress.textContent = this.renderProgressLabel(view);

    const row = document.createElement("aside");
    row.className = `fd-action-pill ${snapshot.config.minimalMode ? "fd-action-pill-minimal" : ""}`;

    const button = (label: string, shortcut: string, action: () => void, kind = "") => {
      const node = document.createElement("button");
      node.type = "button";
      node.className = `fd-pill-btn ${kind}`.trim();
      const labelNode = document.createElement("span");
      labelNode.className = "fd-pill-label";
      labelNode.textContent = label;
      const shortcutNode = document.createElement("span");
      shortcutNode.className = "fd-pill-key";
      shortcutNode.textContent = shortcut;
      node.append(labelNode, shortcutNode);
      node.addEventListener("click", action);
      return node;
    };

    row.append(
      button("Save", "S", () => this.callbacks.onAction("bookmark")),
      button("Not interested", "X", () => this.callbacks.onAction("notInterested"), "danger")
    );

    this.positionActionPill(row, view.focusedHandle?.element ?? null);
    shell.append(progress, row);
    return shell;
  }

  private renderProgressLabel(view: DeckViewState): string {
    const snapshot = view.snapshot;
    if (snapshot.config.mode === "posts") {
      return `${snapshot.stats.viewedCount}/${snapshot.config.postLimit} posts`;
    }

    return `${snapshot.stats.viewedCount} posts`;
  }

  private positionActionPill(node: HTMLElement, anchor: HTMLElement | null): void {
    const estimatedHeight = 56;
    const margin = 12;
    const defaultTop = Math.max(margin, window.innerHeight - estimatedHeight - 18);
    let left = Math.floor(window.innerWidth / 2);
    let top = defaultTop;

    if (anchor) {
      const anchorRect = anchor.getBoundingClientRect();
      left = Math.floor(anchorRect.left + anchorRect.width / 2);

      const nativeActionRow = anchor.querySelector<HTMLElement>("[role='group']");
      const rowRect = nativeActionRow?.getBoundingClientRect() ?? null;

      if (rowRect && rowRect.bottom > 0 && rowRect.top < window.innerHeight) {
        const belowRow = Math.floor(rowRect.bottom + 10);
        const aboveRow = Math.floor(rowRect.top - estimatedHeight - 10);

        if (belowRow + estimatedHeight <= window.innerHeight - margin) {
          top = belowRow;
        } else if (aboveRow >= margin) {
          top = aboveRow;
        } else {
          top = defaultTop;
        }
      }
    }

    node.style.left = `${Math.max(32, Math.min(window.innerWidth - 32, left))}px`;
    node.style.top = `${Math.max(margin, Math.min(window.innerHeight - estimatedHeight - margin, top))}px`;
  }

  private resolveTheme(): "dark" | "light" {
    const explicit = this.state.themeMode;
    if (explicit === "dark" || explicit === "light") {
      return explicit;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  private renderPrompt(): HTMLElement | null {
    if (!this.state.prompt.visible) {
      return null;
    }

    this.normalizePromptPostLimit();

    const backdrop = document.createElement("section");
    backdrop.className = "fd-modal-backdrop";

    const prompt = document.createElement("article");
    prompt.className = "fd-modal fd-surface-card fd-session-gate";

    prompt.append(this.renderSunIcon());

    const title = document.createElement("h3");
    title.className = "fd-surface-title";
    title.textContent = "Start a session to access posts";

    const copy = document.createElement("p");
    copy.className = "fd-surface-body";
    copy.textContent = "FocusDeck keeps feed posts hidden until a session is running.";

    const modeLabel = document.createElement("label");
    modeLabel.className = "fd-field";
    modeLabel.textContent = "Limit type";

    const modeSelect = document.createElement("select");
    const modePosts = document.createElement("option");
    modePosts.value = "posts";
    modePosts.textContent = "By posts";
    const modeTime = document.createElement("option");
    modeTime.value = "time";
    modeTime.textContent = "By time";
    modeSelect.append(modePosts, modeTime);
    modeSelect.value = this.state.prompt.mode;
    modeSelect.addEventListener("change", () => {
      this.state.prompt.mode = modeSelect.value === "time" ? "time" : "posts";
      this.state.prompt.preset = this.state.prompt.mode === "posts" ? "10" : "5";
      this.state.prompt.customValue = this.state.prompt.mode === "posts" ? 10 : 5;
      this.render();
    });
    modeLabel.append(modeSelect);

    const valueLabel = document.createElement("label");
    valueLabel.className = "fd-field";
    valueLabel.textContent = this.state.prompt.mode === "posts" ? "Posts" : "Minutes";

    const valueSelect = document.createElement("select");
    const appendOption = (value: string, label = value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      valueSelect.append(option);
    };

    if (this.state.prompt.mode === "posts") {
      const presets = this.getPostPresetOptions();
      for (const preset of presets) {
        appendOption(String(preset));
      }
      appendOption("custom", "Custom");

      if (this.state.prompt.postLimitCap !== null) {
        const hint = document.createElement("small");
        hint.className = "fd-field-hint";
        hint.textContent = `Remaining today: ${this.state.prompt.postLimitCap} posts`;
        valueLabel.append(hint);
      }
    } else {
      appendOption("5");
      appendOption("10");
      appendOption("15");
      appendOption("custom", "Custom");
    }
    valueSelect.value = this.state.prompt.preset;
    valueSelect.addEventListener("change", () => {
      this.state.prompt.preset = valueSelect.value;
      this.render();
    });
    valueLabel.append(valueSelect);

    const customInput = document.createElement("input");
    customInput.type = "number";
    customInput.min = "1";
    customInput.step = "1";
    if (this.state.prompt.mode === "posts" && this.state.prompt.postLimitCap !== null) {
      customInput.max = String(this.state.prompt.postLimitCap);
    } else {
      customInput.removeAttribute("max");
    }
    customInput.value = String(this.state.prompt.customValue);
    customInput.style.display = this.state.prompt.preset === "custom" ? "block" : "none";
    customInput.addEventListener("change", () => {
      const raw = Math.max(1, Math.floor(Number(customInput.value) || 1));
      if (this.state.prompt.mode === "posts" && this.state.prompt.postLimitCap !== null) {
        this.state.prompt.customValue = Math.min(this.state.prompt.postLimitCap, raw);
      } else {
        this.state.prompt.customValue = raw;
      }
      customInput.value = String(this.state.prompt.customValue);
    });
    valueLabel.append(customInput);

    const actions = document.createElement("div");
    actions.className = "fd-surface-actions";

    const start = document.createElement("button");
    start.type = "button";
    start.className = "fd-surface-btn primary";
    start.textContent = "Start session";
    start.addEventListener("click", () => {
      const raw =
        this.state.prompt.preset === "custom" ? this.state.prompt.customValue : Number(this.state.prompt.preset);
      let value = Math.max(1, Math.floor(raw || 1));

      if (this.state.prompt.mode === "posts" && this.state.prompt.postLimitCap !== null) {
        value = Math.min(this.state.prompt.postLimitCap, value);
      }

      if (this.state.prompt.mode === "posts") {
        this.callbacks.onStartSession({ mode: "posts", postLimit: value });
      } else {
        this.callbacks.onStartSession({ mode: "time", timeLimitMinutes: value });
      }
    });

    actions.append(start);
    prompt.append(title, copy, modeLabel, valueLabel, actions);
    backdrop.append(prompt);
    return backdrop;
  }

  private renderCompletionModal(): HTMLElement | null {
    if (!this.state.completion) {
      return null;
    }

    const backdrop = document.createElement("section");
    backdrop.className = "fd-modal-backdrop";

    const card = document.createElement("article");
    card.className = "fd-modal fd-surface-card";

    card.append(this.renderSunIcon());

    const title = document.createElement("h3");
    title.className = "fd-surface-title";
    title.textContent = "Session complete";

    const body = document.createElement("p");
    body.className = "fd-surface-body";
    body.textContent = `You viewed ${this.state.completion.viewedCount} posts in this session.`;

    const actions = document.createElement("div");
    actions.className = "fd-surface-actions";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "fd-surface-btn";
    close.textContent = "Close";
    close.addEventListener("click", this.callbacks.onDismissComplete);

    const restart = document.createElement("button");
    restart.type = "button";
    restart.className = "fd-surface-btn primary";
    restart.textContent = "Start new session";
    restart.addEventListener("click", this.callbacks.onStartNewSession);

    const extendPosts = document.createElement("button");
    extendPosts.type = "button";
    extendPosts.className = "fd-surface-btn";
    extendPosts.textContent = "Extend +5 posts";
    extendPosts.addEventListener("click", this.callbacks.onExtendPosts);

    const extendMinutes = document.createElement("button");
    extendMinutes.type = "button";
    extendMinutes.className = "fd-surface-btn";
    extendMinutes.textContent = "Extend +2 minutes";
    extendMinutes.addEventListener("click", this.callbacks.onExtendMinutes);

    actions.append(restart, close, extendPosts, extendMinutes);
    card.append(title, body, actions);
    backdrop.append(card);
    return backdrop;
  }

  private renderDailyLimitModal(): HTMLElement | null {
    if (!this.state.dailyLimitReached) {
      return null;
    }

    const backdrop = document.createElement("section");
    backdrop.className = "fd-modal-backdrop fd-daily-backdrop";

    const card = document.createElement("article");
    card.className = "fd-modal fd-daily-limit";

    const icon = this.renderSunIcon();

    const title = document.createElement("h3");
    title.textContent = "Daily limit reached.";

    const body = document.createElement("p");
    body.className = "fd-daily-body";
    const highlighted = document.createElement("strong");
    const posts = this.state.dailyLimitContext.postsToday;
    highlighted.textContent = `${posts ?? 0} posts`;

    if (posts !== null) {
      body.append("You've viewed ", highlighted, ` on ${this.state.dailyLimitContext.siteLabel} today.`);
    } else {
      body.textContent = `You've reached your daily limit on ${this.state.dailyLimitContext.siteLabel} today.`;
    }

    const caption = document.createElement("p");
    caption.className = "fd-daily-caption";
    caption.textContent = "Rest is productive too.";

    const actions = document.createElement("div");
    actions.className = "fd-daily-actions";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "fd-daily-btn primary";
    close.textContent = "Close Feed";
    close.addEventListener("click", this.callbacks.onDismissDailyLimit);

    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "fd-daily-btn";
    settings.textContent = "Settings";
    settings.addEventListener("click", this.callbacks.onOpenSettings);

    const brand = document.createElement("p");
    brand.className = "fd-daily-brand";
    brand.textContent = "FocusDeck";

    actions.append(close, settings);
    card.append(icon, title, body, caption, actions, brand);
    backdrop.append(card);
    return backdrop;
  }

  private renderStatus(): HTMLElement | null {
    if (!this.state.status || this.state.focusLayerSuppressed) {
      return null;
    }

    const status = document.createElement("aside");
    status.className = "fd-status";
    status.textContent = this.state.status;
    return status;
  }

  private renderSunIcon(): HTMLElement {
    const icon = document.createElement("div");
    icon.className = "fd-daily-icon";
    const iconCore = document.createElement("span");
    iconCore.className = "fd-daily-icon-core";
    icon.append(iconCore);
    return icon;
  }

  private getPostPresetOptions(): number[] {
    const defaults = [10, 20, 30];
    const cap = this.state.prompt.postLimitCap;
    if (cap === null) {
      return defaults;
    }

    if (cap > defaults[defaults.length - 1]) {
      return defaults;
    }

    const allowed = defaults.filter((value) => value <= cap);
    if (!allowed.length || !allowed.includes(cap)) {
      allowed.unshift(cap);
    }

    return Array.from(new Set(allowed)).sort((a, b) => a - b);
  }

  private normalizePromptPostLimit(): void {
    if (this.state.prompt.mode !== "posts") {
      return;
    }

    const cap = this.state.prompt.postLimitCap;
    if (cap === null) {
      return;
    }

    const currentValue =
      this.state.prompt.preset === "custom" ? this.state.prompt.customValue : Number(this.state.prompt.preset);
    const safeValue = Math.max(1, Math.min(cap, Math.floor(currentValue || 1)));

    if (this.state.prompt.preset === "custom") {
      this.state.prompt.customValue = safeValue;
      return;
    }

    const allowedPresets = new Set(this.getPostPresetOptions().map((value) => String(value)));
    if (allowedPresets.has(this.state.prompt.preset)) {
      return;
    }

    if (allowedPresets.has(String(safeValue))) {
      this.state.prompt.preset = String(safeValue);
      return;
    }

    this.state.prompt.preset = "custom";
    this.state.prompt.customValue = safeValue;
  }
}
