import { browserApi } from "@/shared/browser-polyfill";
import type { RuntimeMessage, RuntimeResponse, SiteSettings } from "@/types/messages";
import type { DailyLimitsConfig, DailyUsage, SessionConfig, ThemeMode } from "@/types/session";

const PANEL_META: Record<string, { title: string; description: string }> = {
  general: {
    title: "General",
    description: "Theme and baseline behavior for FocusDeck overlays."
  },
  limits: {
    title: "Limits",
    description: "Total daily post limit across all sessions (resets at 12:00 AM local browser time)."
  }
};

interface DraftState {
  themeMode: ThemeMode;
  sharedDailyLimit: number;
  hideDistractingElements: boolean;
  bypassFollowingFeed: boolean;
}

const THEME_CACHE_KEY = "focusdeck:settings-theme-mode";
const SITE_ID = "x";

function mustElement<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return node;
}

function send<T>(message: RuntimeMessage): Promise<RuntimeResponse<T>> {
  return browserApi.runtime.sendMessage(message as unknown as Parameters<typeof browserApi.runtime.sendMessage>[0]) as Promise<
    RuntimeResponse<T>
  >;
}

function toInt(value: string, fallback = 0): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, parsed);
}

function formatUsage(usage: DailyUsage): string {
  return `Today (${usage.dateKey}): ${usage.global.postsViewed} posts viewed.`;
}

const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item[data-tab]"));
const panelTitle = mustElement<HTMLHeadingElement>("#panelTitle");
const panelDescription = mustElement<HTMLParagraphElement>("#panelDescription");
const panelGeneral = mustElement<HTMLElement>("#panel-general");
const panelLimits = mustElement<HTMLElement>("#panel-limits");
const themeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="themeMode"]'));
const sharedDailyLimit = mustElement<HTMLInputElement>("#sharedDailyLimit");
const hideDistractingElements = mustElement<HTMLInputElement>("#hideDistractingElements");
const bypassFollowingFeed = mustElement<HTMLInputElement>("#bypassFollowingFeed");
const usageSummary = mustElement<HTMLParagraphElement>("#usageSummary");
const status = mustElement<HTMLParagraphElement>("#status");
const applyChanges = mustElement<HTMLButtonElement>("#applyChanges");
const resetDefaults = mustElement<HTMLButtonElement>("#resetDefaults");
const clearSnapshot = mustElement<HTMLButtonElement>("#clearSnapshot");
const clearDailyUsage = mustElement<HTMLButtonElement>("#clearDailyUsage");

const draft: DraftState = {
  themeMode: "system",
  sharedDailyLimit: 100,
  hideDistractingElements: false,
  bypassFollowingFeed: false
};

let savedDailyLimits: DailyLimitsConfig | null = null;
let savedSiteSettings: SiteSettings | null = null;
let dirty = false;

function setStatus(message: string): void {
  status.textContent = message;
}

function setDirty(next: boolean): void {
  dirty = next;
  applyChanges.disabled = !dirty;
}

function readThemeMode(): ThemeMode {
  const checked = themeInputs.find((input) => input.checked)?.value;
  return checked === "light" || checked === "dark" ? checked : "system";
}

function renderThemeMode(mode: ThemeMode): void {
  for (const input of themeInputs) {
    input.checked = input.value === mode;
  }
  applyThemePreview(mode);
}

function applyThemePreview(mode: ThemeMode): void {
  if (mode === "system") {
    document.documentElement.removeAttribute("data-fd-theme");
    return;
  }

  document.documentElement.setAttribute("data-fd-theme", mode);
}

function cacheThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, mode);
  } catch {
    // ignore localStorage failures
  }
}

function showPanel(tabId: string): void {
  const isLimits = tabId === "limits";

  panelGeneral.classList.toggle("is-hidden", isLimits);
  panelLimits.classList.toggle("is-hidden", !isLimits);

  for (const button of navButtons) {
    const active = button.dataset.tab === tabId;
    button.classList.toggle("nav-item-active", active);
  }

  const meta = PANEL_META[tabId] ?? PANEL_META.general;
  panelTitle.textContent = meta.title;
  panelDescription.textContent = meta.description;
}

function syncDraftFromForm(): void {
  draft.themeMode = readThemeMode();
  draft.sharedDailyLimit = toInt(sharedDailyLimit.value, draft.sharedDailyLimit);
  draft.hideDistractingElements = hideDistractingElements.checked;
  draft.bypassFollowingFeed = bypassFollowingFeed.checked;
}

function renderDraftToForm(): void {
  renderThemeMode(draft.themeMode);
  sharedDailyLimit.value = String(draft.sharedDailyLimit);
  hideDistractingElements.checked = draft.hideDistractingElements;
  bypassFollowingFeed.checked = draft.bypassFollowingFeed;
}

function normalizeDailyLimits(limits: DailyLimitsConfig | null | undefined): DailyLimitsConfig {
  return {
    global: {
      maxPosts: Math.max(0, Math.floor(limits?.global.maxPosts || 0))
    },
    perSite: { ...(limits?.perSite ?? {}) }
  };
}

function readDailyLimitPayload(baseLimits: DailyLimitsConfig | null | undefined): DailyLimitsConfig {
  const normalized = normalizeDailyLimits(baseLimits);
  return {
    global: {
      maxPosts: draft.sharedDailyLimit
    },
    perSite: { ...normalized.perSite }
  };
}

async function applyAllChanges(): Promise<void> {
  syncDraftFromForm();
  const [existingLimitsRes, existingSiteSettingsRes] = await Promise.all([
    send<DailyLimitsConfig>({ type: "focusdeck:get-daily-limits" }),
    send<SiteSettings>({ type: "focusdeck:get-site-settings", siteId: SITE_ID })
  ]);
  const baseLimits = existingLimitsRes.ok && existingLimitsRes.data ? existingLimitsRes.data : savedDailyLimits;
  const dailyLimitPayload = readDailyLimitPayload(baseLimits);
  const siteSettingsPayload: Partial<SiteSettings> = {
    hideDistractingElements: draft.hideDistractingElements,
    bypassFollowingFeed: draft.bypassFollowingFeed
  };
  const existingSiteSettings =
    existingSiteSettingsRes.ok && existingSiteSettingsRes.data ? existingSiteSettingsRes.data : savedSiteSettings;
  if (existingSiteSettings?.enabled === false) {
    siteSettingsPayload.enabled = false;
  }

  const [configRes, limitsRes, siteSettingsRes] = await Promise.all([
    send<SessionConfig>({
      type: "focusdeck:set-config",
      payload: { themeMode: draft.themeMode }
    }),
    send<DailyLimitsConfig>({
      type: "focusdeck:set-daily-limits",
      payload: dailyLimitPayload
    }),
    send<SiteSettings>({
      type: "focusdeck:set-site-settings",
      siteId: SITE_ID,
      payload: siteSettingsPayload
    })
  ]);

  if (!configRes.ok) {
    setStatus(configRes.error ?? "Failed to save theme settings.");
    return;
  }

  if (!limitsRes.ok) {
    setStatus(limitsRes.error ?? "Failed to save daily limit.");
    return;
  }

  if (limitsRes.data) {
    savedDailyLimits = normalizeDailyLimits(limitsRes.data);
  }

  if (!siteSettingsRes.ok) {
    setStatus(siteSettingsRes.error ?? "Failed to save site settings.");
    return;
  }

  if (siteSettingsRes.data) {
    savedSiteSettings = siteSettingsRes.data;
  }

  cacheThemeMode(draft.themeMode);
  setDirty(false);
  setStatus("Changes applied.");
}

async function loadData(): Promise<void> {
  const [configRes, limitsRes, usageRes, siteSettingsRes] = await Promise.all([
    send<SessionConfig>({ type: "focusdeck:get-config" }),
    send<DailyLimitsConfig>({ type: "focusdeck:get-daily-limits" }),
    send<DailyUsage>({ type: "focusdeck:get-daily-usage" }),
    send<SiteSettings>({ type: "focusdeck:get-site-settings", siteId: SITE_ID })
  ]);

  if (configRes.ok && configRes.data) {
    draft.themeMode = configRes.data.themeMode;
    cacheThemeMode(draft.themeMode);
  }

  if (limitsRes.ok && limitsRes.data) {
    savedDailyLimits = normalizeDailyLimits(limitsRes.data);
    draft.sharedDailyLimit = savedDailyLimits.global.maxPosts;
  }

  if (siteSettingsRes.ok && siteSettingsRes.data) {
    savedSiteSettings = siteSettingsRes.data;
    draft.hideDistractingElements = siteSettingsRes.data.hideDistractingElements;
    draft.bypassFollowingFeed = siteSettingsRes.data.bypassFollowingFeed;
  }

  renderDraftToForm();

  if (usageRes.ok && usageRes.data) {
    usageSummary.textContent = formatUsage(usageRes.data);
  } else {
    usageSummary.textContent = "Unable to load usage.";
  }

  setDirty(false);
  setStatus("Ready");
}

for (const button of navButtons) {
  button.addEventListener("click", () => {
    const tab = button.dataset.tab === "limits" ? "limits" : "general";
    showPanel(tab);
  });
}

for (const input of themeInputs) {
  input.addEventListener("change", () => {
    draft.themeMode = readThemeMode();
    applyThemePreview(draft.themeMode);
    setDirty(true);
    setStatus("Unsaved changes.");
  });
}

sharedDailyLimit.addEventListener("change", () => {
  sharedDailyLimit.value = String(toInt(sharedDailyLimit.value, 0));
  draft.sharedDailyLimit = toInt(sharedDailyLimit.value, 0);
  setDirty(true);
  setStatus("Unsaved changes.");
});

hideDistractingElements.addEventListener("change", () => {
  draft.hideDistractingElements = hideDistractingElements.checked;
  setDirty(true);
  setStatus("Unsaved changes.");
});

bypassFollowingFeed.addEventListener("change", () => {
  draft.bypassFollowingFeed = bypassFollowingFeed.checked;
  setDirty(true);
  setStatus("Unsaved changes.");
});

applyChanges.addEventListener("click", () => {
  void applyAllChanges();
});

resetDefaults.addEventListener("click", () => {
  draft.themeMode = "system";
  draft.sharedDailyLimit = 100;
  draft.hideDistractingElements = false;
  draft.bypassFollowingFeed = false;
  renderDraftToForm();
  setDirty(true);
  setStatus("Defaults restored locally. Click Apply changes to save.");
});

clearSnapshot.addEventListener("click", () => {
  void send({ type: "focusdeck:clear-session-snapshot" }).then((response) => {
    setStatus(response.ok ? "Cleared unfinished session." : response.error ?? "Could not clear session.");
  });
});

clearDailyUsage.addEventListener("click", () => {
  if (!window.confirm("Reset today's local usage counters?")) {
    return;
  }

  void send<DailyUsage>({ type: "focusdeck:clear-daily-usage" }).then((response) => {
    if (!response.ok || !response.data) {
      setStatus(response.error ?? "Could not reset usage.");
      return;
    }

    usageSummary.textContent = formatUsage(response.data);
    setStatus("Reset today's usage.");
  });
});

showPanel("general");
setDirty(false);
void loadData();
