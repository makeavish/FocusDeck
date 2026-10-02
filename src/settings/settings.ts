import { browserApi } from "@/shared/browser-polyfill";
import type { RuntimeMessage, RuntimeResponse, SiteSettings } from "@/types/messages";
import type { DailyLimitsConfig, DailyUsage, SessionConfig, ThemeMode } from "@/types/session";

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

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const themeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="themeMode"]'));
const sharedDailyLimit = mustElement<HTMLInputElement>("#sharedDailyLimit");
const hideDistractingElements = mustElement<HTMLInputElement>("#hideDistractingElements");
const bypassFollowingFeed = mustElement<HTMLInputElement>("#bypassFollowingFeed");
const usageSummary = mustElement<HTMLParagraphElement>("#usageSummary");
const usageMeter = mustElement<HTMLSpanElement>("#usageMeter");
const status = mustElement<HTMLParagraphElement>("#status");
const savebar = mustElement<HTMLElement>(".savebar");
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
let todayUsage: DailyUsage | null = null;
let dirty = false;

function setStatus(message: string): void {
  status.textContent = message;
}

function setDirty(next: boolean): void {
  dirty = next;
  applyChanges.disabled = !dirty;
  savebar.dataset.dirty = String(dirty);
}

function markUnsaved(): void {
  setDirty(true);
  setStatus("Unsaved changes");
}

// Size the big limit numeral to its digits so "posts a day" sits right after it.
function sizeLimitInput(): void {
  sharedDailyLimit.style.width = `${Math.max(1, sharedDailyLimit.value.length) + 0.4}ch`;
}

function renderUsage(): void {
  const meter = usageMeter.parentElement;
  if (!todayUsage) {
    usageSummary.textContent = "Couldn't load today's count.";
    meter?.setAttribute("data-state", "off");
    return;
  }

  const viewed = todayUsage.global.postsViewed;
  const limit = draft.sharedDailyLimit;
  const count = document.createElement("strong");

  if (limit <= 0) {
    count.textContent = plural(viewed, "post");
    usageSummary.replaceChildren(count, " viewed today. No daily limit set.");
    meter?.setAttribute("data-state", "off");
    return;
  }

  count.textContent = String(viewed);
  usageSummary.replaceChildren(count, ` of ${plural(limit, "post")} viewed today`);
  usageMeter.style.width = `${Math.min(100, (viewed / limit) * 100)}%`;
  meter?.setAttribute("data-state", viewed >= limit ? "over" : "on");
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

function syncDraftFromForm(): void {
  draft.themeMode = readThemeMode();
  draft.sharedDailyLimit = toInt(sharedDailyLimit.value, draft.sharedDailyLimit);
  draft.hideDistractingElements = hideDistractingElements.checked;
  draft.bypassFollowingFeed = bypassFollowingFeed.checked;
}

function renderDraftToForm(): void {
  renderThemeMode(draft.themeMode);
  sharedDailyLimit.value = String(draft.sharedDailyLimit);
  sizeLimitInput();
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
    setStatus(configRes.error ?? "Couldn't save the theme.");
    return;
  }

  if (!limitsRes.ok) {
    setStatus(limitsRes.error ?? "Couldn't save the daily limit.");
    return;
  }

  if (limitsRes.data) {
    savedDailyLimits = normalizeDailyLimits(limitsRes.data);
  }

  if (!siteSettingsRes.ok) {
    setStatus(siteSettingsRes.error ?? "Couldn't save feed settings.");
    return;
  }

  if (siteSettingsRes.data) {
    savedSiteSettings = siteSettingsRes.data;
  }

  cacheThemeMode(draft.themeMode);
  setDirty(false);
  setStatus("Changes saved");
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

  todayUsage = usageRes.ok && usageRes.data ? usageRes.data : null;
  renderUsage();

  setDirty(false);
  setStatus("No unsaved changes");
}

for (const input of themeInputs) {
  input.addEventListener("change", () => {
    draft.themeMode = readThemeMode();
    applyThemePreview(draft.themeMode);
    markUnsaved();
  });
}

sharedDailyLimit.addEventListener("input", () => {
  sizeLimitInput();
  draft.sharedDailyLimit = toInt(sharedDailyLimit.value, 0);
  renderUsage();
  markUnsaved();
});

sharedDailyLimit.addEventListener("change", () => {
  sharedDailyLimit.value = String(toInt(sharedDailyLimit.value, 0));
  sizeLimitInput();
  draft.sharedDailyLimit = toInt(sharedDailyLimit.value, 0);
  renderUsage();
  markUnsaved();
});

hideDistractingElements.addEventListener("change", () => {
  draft.hideDistractingElements = hideDistractingElements.checked;
  markUnsaved();
});

bypassFollowingFeed.addEventListener("change", () => {
  draft.bypassFollowingFeed = bypassFollowingFeed.checked;
  markUnsaved();
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
  renderUsage();
  setDirty(true);
  setStatus("Defaults restored. Save to keep them.");
});

clearSnapshot.addEventListener("click", () => {
  void send({ type: "focusdeck:clear-session-snapshot" }).then((response) => {
    setStatus(response.ok ? "Unfinished session cleared" : response.error ?? "Couldn't clear the unfinished session.");
  });
});

clearDailyUsage.addEventListener("click", () => {
  if (!window.confirm("Reset today's post count to 0?")) {
    return;
  }

  void send<DailyUsage>({ type: "focusdeck:clear-daily-usage" }).then((response) => {
    if (!response.ok || !response.data) {
      setStatus(response.error ?? "Couldn't reset today's count.");
      return;
    }

    todayUsage = response.data;
    renderUsage();
    setStatus("Today's count reset");
  });
});

setDirty(false);
void loadData();
