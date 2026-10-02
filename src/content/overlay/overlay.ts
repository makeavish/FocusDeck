import type { AdapterAction } from "@/types/adapter";
import type { DeckViewState } from "@/core/deck-engine";
import type { SessionConfig, ThemeMode } from "@/types/session";
import { OVERLAY_HOST_ID, OVERLAY_Z_INDEX } from "@/shared/constants";
import overlayStyles from "@/content/overlay/styles.css?inline";

export interface OverlayCallbacks {
  onStartSession: (partial: Partial<SessionConfig>) => void;
  onAction: (action: AdapterAction) => void;
  onOpenPost: () => void;
  onDismissDailyLimit: () => void;
  onOpenSettings: () => void;
  onBlockingModalVisibilityChange: (visible: boolean) => void;
}

interface PromptState {
  visible: boolean;
  preset: string;
  customValue: number;
  postLimitCap: number | null;
}

interface OverlayState {
  view: DeckViewState | null;
  themeMode: ThemeMode;
  status: string | null;
  prompt: PromptState;
  dailyLimitReached: boolean;
  dailyLimitContext: {
    postsToday: number | null;
    siteLabel: string;
  };
}

export class OverlayController {
  private host: HTMLDivElement | null = null;
  private shadow: ShadowRoot | null = null;
  private app: HTMLElement | null = null;
  private blockingModalVisible = false;
  private focusBeforeModal: HTMLElement | null = null;
  private focusKeyBeforeModal: string | null = null;

  private readonly containModalFocus = (event: KeyboardEvent): void => {
    if (!this.blockingModalVisible || event.key !== "Tab") {
      return;
    }
    const modal = this.getActiveModal();
    if (!modal) {
      return;
    }
    const controls = Array.from(modal.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, a[href], [tabindex]"
    )).filter((node) => node.tabIndex >= 0 && !node.matches(":disabled") && !node.closest("[hidden], [inert]"));
    const active = this.shadow?.activeElement;
    const index = controls.findIndex((node) => node === active);
    const next = event.shiftKey
      ? (index <= 0 ? controls.length - 1 : index - 1)
      : (index + 1) % controls.length;
    event.preventDefault();
    event.stopPropagation();
    (controls[next] ?? modal).focus({ preventScroll: true });
  };

  private readonly redirectModalFocus = (event: FocusEvent): void => {
    const modal = this.getActiveModal();
    const origin = event.composedPath()[0];
    if (this.blockingModalVisible && modal && (!(origin instanceof Node) || !modal.contains(origin))) {
      (modal.querySelector<HTMLElement>("[data-fd-autofocus]") ?? modal).focus({ preventScroll: true });
    }
  };

  private readonly state: OverlayState = {
    view: null,
    themeMode: "system",
    status: null,
    prompt: {
      visible: false,
      preset: "10",
      customValue: 10,
      postLimitCap: null
    },
    dailyLimitReached: false,
    dailyLimitContext: {
      postsToday: null,
      siteLabel: "X"
    }
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
    document.addEventListener("keydown", this.containModalFocus, true);
    document.addEventListener("focusin", this.redirectModalFocus, true);
    this.render();
  }

  unmount(): void {
    this.setBlockingModalVisibility(false);
    document.removeEventListener("keydown", this.containModalFocus, true);
    document.removeEventListener("focusin", this.redirectModalFocus, true);
    this.restorePreviousFocus();

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

  setDailyLimitReached(reached: boolean): void {
    this.state.dailyLimitReached = reached;
    this.render();
  }

  setDailyLimitContext(context: { postsToday: number | null; siteLabel: string }): void {
    this.state.dailyLimitContext = context;
    this.render();
  }

  private render(): void {
    if (!this.app) {
      return;
    }

    const focusKey = this.readFocusKey();
    const modalWasVisible = this.blockingModalVisible;
    const modalWillBeVisible = this.state.prompt.visible || this.state.dailyLimitReached;
    if (!modalWasVisible && modalWillBeVisible) {
      const active = this.shadow?.activeElement ?? document.activeElement;
      this.focusBeforeModal = active instanceof HTMLElement ? active : null;
      this.focusKeyBeforeModal = focusKey;
    }

    this.app.className = `fd-root fd-theme-${this.resolveTheme()}`;

    this.app.replaceChildren();

    const stack = document.createElement("div");
    stack.className = "fd-stack";

    const floating = this.renderFloating();
    if (floating) {
      stack.append(floating);
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

    const daily = this.renderDailyLimitModal();
    if (daily) {
      this.app.append(daily);
    }

    this.setBlockingModalVisibility(this.state.prompt.visible || this.state.dailyLimitReached);
    if (modalWasVisible && !this.blockingModalVisible) {
      this.restorePreviousFocus();
    } else {
      this.restoreFocus(focusKey, !modalWasVisible && this.blockingModalVisible);
    }
  }

  // render() rebuilds the tree, so carry keyboard focus across by a stable key.
  private readFocusKey(): string | null {
    const active = this.shadow?.activeElement;
    return active instanceof HTMLElement ? active.dataset.fdFocusKey ?? null : null;
  }

  private restoreFocus(focusKey: string | null, modalOpened: boolean): void {
    if (!this.app) {
      return;
    }

    const scope = this.blockingModalVisible ? this.getActiveModal() : this.app;
    const target =
      (focusKey ? scope?.querySelector<HTMLElement>(`[data-fd-focus-key="${focusKey}"]`) : null) ??
      (this.blockingModalVisible || modalOpened ? scope?.querySelector<HTMLElement>("[data-fd-autofocus]") ?? scope : null);
    target?.focus({ preventScroll: true });
  }

  private getActiveModal(): HTMLElement | null {
    return this.app?.querySelector<HTMLElement>(".fd-daily-limit") ?? this.app?.querySelector<HTMLElement>(".fd-session-gate") ?? null;
  }

  private restorePreviousFocus(): void {
    const previous = this.focusBeforeModal;
    const target = previous?.isConnected ? previous :
      this.focusKeyBeforeModal ? this.app?.querySelector<HTMLElement>(`[data-fd-focus-key="${this.focusKeyBeforeModal}"]`) : null;
    if (target && !target.closest("[inert]")) {
      target.focus({ preventScroll: true });
    }
    this.focusBeforeModal = null;
    this.focusKeyBeforeModal = null;
  }

  private setBlockingModalVisibility(visible: boolean): void {
    if (this.blockingModalVisible === visible) {
      return;
    }

    this.blockingModalVisible = visible;
    this.callbacks.onBlockingModalVisibilityChange(visible);
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

    if (prev.config.postLimit !== curr.config.postLimit) {
      return false;
    }

    if (prev.config.themeMode !== curr.config.themeMode) {
      return false;
    }

    return true;
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

    const dock = document.createElement("aside");
    dock.className = "fd-top-dock";
    dock.setAttribute("aria-label", "FocusDeck session");

    const row = document.createElement("div");
    row.className = `fd-action-pill ${snapshot.config.minimalMode ? "fd-action-pill-minimal" : ""}`.trim();
    row.setAttribute("role", "toolbar");
    row.setAttribute("aria-label", "Post actions");

    const button = (label: string, shortcut: string, action: () => void, kind = "") => {
      const node = document.createElement("button");
      node.type = "button";
      node.className = `fd-pill-btn ${kind}`.trim();
      node.dataset.fdFocusKey = `action-${label.toLowerCase()}`;
      node.setAttribute("aria-keyshortcuts", shortcut);
      const labelNode = document.createElement("span");
      labelNode.className = "fd-pill-label";
      labelNode.textContent = label;
      const shortcutNode = document.createElement("kbd");
      shortcutNode.className = "fd-pill-key";
      shortcutNode.textContent = shortcut;
      node.append(labelNode, shortcutNode);
      node.addEventListener("click", action);
      return node;
    };

    row.append(
      button("Open", "O", this.callbacks.onOpenPost),
      button("Save", "S", () => this.callbacks.onAction("bookmark")),
      button("Hide", "X", () => this.callbacks.onAction("notInterested"), "danger")
    );

    dock.append(this.renderProgress(view), row);
    shell.append(dock);
    return shell;
  }

  private renderProgress(view: DeckViewState): HTMLElement {
    const { stats, config } = view.snapshot;
    const limit = Math.max(1, config.postLimit);
    const viewed = Math.min(stats.viewedCount, limit);

    const progress = document.createElement("div");
    progress.className = "fd-progress-pill";
    progress.title = `${stats.viewedCount} of ${config.postLimit} posts viewed this session`;

    const count = document.createElement("span");
    count.className = "fd-progress-count";
    const current = document.createElement("strong");
    current.textContent = String(stats.viewedCount);
    count.append(current, `/${config.postLimit}`);

    const unit = document.createElement("span");
    unit.className = "fd-progress-unit";
    unit.textContent = "posts";

    const track = document.createElement("span");
    track.className = "fd-progress-track";
    track.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    fill.className = "fd-progress-fill";
    fill.style.width = `${(viewed / limit) * 100}%`;
    track.append(fill);

    progress.append(count, unit, track);
    return progress;
  }

  private resolveTheme(): "dark" | "light" {
    const explicit = this.state.themeMode;
    if (explicit === "dark" || explicit === "light") {
      return explicit;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  private renderPrompt(): HTMLElement | null {
    if (!this.state.prompt.visible || this.state.dailyLimitReached) {
      return null;
    }

    this.normalizePromptPostLimit();

    const backdrop = document.createElement("section");
    backdrop.className = "fd-modal-backdrop";

    const prompt = document.createElement("article");
    prompt.className = "fd-modal fd-session-gate";
    prompt.tabIndex = -1;
    prompt.setAttribute("role", "dialog");
    prompt.setAttribute("aria-modal", "true");
    prompt.setAttribute("aria-labelledby", "fd-prompt-title");
    prompt.setAttribute("aria-describedby", "fd-prompt-body");

    const title = document.createElement("h2");
    title.id = "fd-prompt-title";
    title.className = "fd-modal-title";
    title.textContent = "How many posts this time?";

    const copy = document.createElement("p");
    copy.id = "fd-prompt-body";
    copy.className = "fd-modal-body";
    copy.textContent = "You'll see one post at a time. The feed locks again when you reach your number.";

    const choices = document.createElement("div");
    choices.className = "fd-choices";
    choices.setAttribute("role", "group");
    choices.setAttribute("aria-label", "Posts this session");

    const choice = (value: string, label: string, extraClass = "") => {
      const node = document.createElement("button");
      node.type = "button";
      node.className = `fd-choice ${extraClass}`.trim();
      node.dataset.fdFocusKey = `choice-${value}`;
      const selected = this.state.prompt.preset === value;
      node.setAttribute("aria-pressed", String(selected));
      node.textContent = label;
      node.addEventListener("click", () => {
        if (this.state.prompt.preset === value) {
          return;
        }
        this.state.prompt.preset = value;
        this.render();
        if (value === "custom") {
          this.app?.querySelector<HTMLInputElement>('[data-fd-focus-key="custom-input"]')?.focus({ preventScroll: true });
        }
      });
      return node;
    };

    for (const preset of this.getPostPresetOptions()) {
      choices.append(choice(String(preset), String(preset)));
    }
    choices.append(choice("custom", "Custom", "fd-choice-custom"));

    const isCustom = this.state.prompt.preset === "custom";
    const custom = document.createElement("label");
    custom.className = "fd-custom";
    custom.hidden = !isCustom;

    const customLabel = document.createElement("span");
    customLabel.textContent = "Custom target";

    const customInput = document.createElement("input");
    customInput.className = "fd-custom-input";
    customInput.dataset.fdFocusKey = "custom-input";
    customInput.type = "number";
    customInput.inputMode = "numeric";
    customInput.min = "1";
    customInput.step = "1";
    if (this.state.prompt.postLimitCap !== null) {
      customInput.max = String(this.state.prompt.postLimitCap);
    } else {
      customInput.removeAttribute("max");
    }
    customInput.value = String(this.state.prompt.customValue);

    const customUnit = document.createElement("span");
    customUnit.className = "fd-custom-unit";
    customUnit.textContent = "posts";

    custom.append(customLabel, customInput, customUnit);

    const start = document.createElement("button");
    start.type = "button";
    start.className = "fd-btn fd-btn-primary fd-btn-block";
    start.dataset.fdFocusKey = "start";
    start.dataset.fdAutofocus = "";

    const updateStartLabel = () => {
      const value = this.resolvePromptPostLimitValue();
      start.textContent = `Start ${value}-post session`;
    };

    const syncCustomValue = () => {
      const raw = Math.max(1, Math.floor(Number(customInput.value) || 1));
      if (this.state.prompt.postLimitCap !== null) {
        this.state.prompt.customValue = Math.min(this.state.prompt.postLimitCap, raw);
      } else {
        this.state.prompt.customValue = raw;
      }
      customInput.value = String(this.state.prompt.customValue);
      updateStartLabel();
    };
    customInput.addEventListener("input", syncCustomValue);
    customInput.addEventListener("change", syncCustomValue);
    customInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        start.click();
      }
    });

    updateStartLabel();
    start.addEventListener("click", () => {
      const value = this.resolvePromptPostLimitValue();
      this.callbacks.onStartSession({ postLimit: value });
    });

    prompt.append(this.renderBrand(), title, copy, choices, custom);

    if (this.state.prompt.postLimitCap !== null) {
      const remaining = document.createElement("p");
      remaining.className = "fd-modal-note";
      const cap = this.state.prompt.postLimitCap;
      remaining.textContent = `${cap} ${cap === 1 ? "post" : "posts"} left in today's limit.`;
      prompt.append(remaining);
    }

    prompt.append(start);
    backdrop.append(prompt);
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
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "fd-daily-title");
    card.setAttribute("aria-describedby", "fd-daily-body");
    card.tabIndex = -1;
    card.dataset.fdAutofocus = "";

    const title = document.createElement("h2");
    title.id = "fd-daily-title";
    title.className = "fd-modal-title";
    title.textContent = "Daily limit reached";

    const { postsToday, siteLabel } = this.state.dailyLimitContext;

    const body = document.createElement("div");
    body.id = "fd-daily-body";
    body.className = "fd-daily-stat";

    if (postsToday !== null) {
      const figure = document.createElement("span");
      figure.className = "fd-daily-figure";
      figure.textContent = String(postsToday);

      const caption = document.createElement("span");
      caption.className = "fd-daily-caption";
      caption.textContent = `${postsToday === 1 ? "post" : "posts"} viewed on ${siteLabel} today`;
      body.append(figure, caption);
    } else {
      const caption = document.createElement("p");
      caption.className = "fd-modal-body";
      caption.textContent = `You've used today's post limit on ${siteLabel}.`;
      body.append(caption);
    }

    const note = document.createElement("p");
    note.className = "fd-modal-note";
    note.textContent = "Your feed unlocks again at midnight.";

    const actions = document.createElement("div");
    actions.className = "fd-modal-actions";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "fd-btn fd-btn-primary";
    close.dataset.fdFocusKey = "daily-close";
    close.textContent = "Close tab";
    close.addEventListener("click", this.callbacks.onDismissDailyLimit);

    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "fd-btn fd-btn-quiet";
    settings.dataset.fdFocusKey = "daily-settings";
    settings.textContent = "Open settings";
    settings.addEventListener("click", this.callbacks.onOpenSettings);

    actions.append(close, settings);
    card.append(this.renderBrand(), title, body, note, actions);
    backdrop.append(card);
    return backdrop;
  }

  private renderStatus(): HTMLElement | null {
    if (!this.state.status) {
      return null;
    }

    const status = document.createElement("aside");
    status.className = "fd-status";
    status.setAttribute("role", "status");
    status.textContent = this.state.status;
    return status;
  }

  private renderBrand(): HTMLElement {
    const brand = document.createElement("p");
    brand.className = "fd-brand";

    const svgNs = "http://www.w3.org/2000/svg";
    const mark = document.createElementNS(svgNs, "svg");
    mark.setAttribute("viewBox", "0 0 20 20");
    mark.setAttribute("aria-hidden", "true");
    mark.classList.add("fd-brand-mark");

    const rect = (x: string, y: string, className?: string) => {
      const node = document.createElementNS(svgNs, "rect");
      node.setAttribute("x", x);
      node.setAttribute("y", y);
      node.setAttribute("width", "13");
      node.setAttribute("height", "11");
      node.setAttribute("rx", "2.5");
      if (className) {
        node.classList.add(className);
      }
      return node;
    };

    const back = rect("5", "2", "fd-brand-mark-back");
    const front = rect("2", "7");

    const dot = document.createElementNS(svgNs, "circle");
    dot.setAttribute("cx", "8.5");
    dot.setAttribute("cy", "12.5");
    dot.setAttribute("r", "2.25");
    dot.classList.add("fd-brand-mark-dot");

    mark.append(back, front, dot);
    brand.append(mark, "FocusDeck");
    return brand;
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

  private resolvePromptPostLimitValue(): number {
    const raw = this.state.prompt.preset === "custom" ? this.state.prompt.customValue : Number(this.state.prompt.preset);
    let value = Math.max(1, Math.floor(raw || 1));
    const cap = this.state.prompt.postLimitCap;
    if (cap !== null) {
      value = Math.min(cap, value);
    }
    return value;
  }

  private normalizePromptPostLimit(): void {
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
