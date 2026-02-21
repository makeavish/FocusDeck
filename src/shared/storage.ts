import { normalizeUsageForDate } from "@/core/daily-counter";
import { DEFAULT_DAILY_LIMITS, DEFAULT_SESSION_CONFIG, DEFAULT_SITE_SETTINGS, STORAGE_KEYS } from "@/shared/constants";
import { browserApi } from "@/shared/browser-polyfill";
import type { SiteSettings } from "@/types/messages";
import type { DailyLimitsConfig, DailyUsage, SessionConfig, SessionSnapshot } from "@/types/session";

type SiteSettingsMap = Record<string, SiteSettings>;

type StorageShape = {
  [STORAGE_KEYS.sessionConfig]?: SessionConfig;
  [STORAGE_KEYS.sessionSnapshot]?: SessionSnapshot;
  [STORAGE_KEYS.siteSettings]?: SiteSettingsMap;
  [STORAGE_KEYS.dailyLimits]?: DailyLimitsConfig;
  [STORAGE_KEYS.dailyUsage]?: DailyUsage;
};

function nowDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function storageGet<Key extends keyof StorageShape>(key: Key): Promise<StorageShape[Key] | undefined> {
  const items = await browserApi.storage.local.get(key);
  return (items as StorageShape)[key];
}

async function storageSet(values: Partial<StorageShape>): Promise<void> {
  await browserApi.storage.local.set(values);
}

async function storageRemove(key: keyof StorageShape): Promise<void> {
  await browserApi.storage.local.remove(key);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNonNegativeInt(value: unknown, fallback = 0): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, parsed);
}

function toPositiveInt(value: unknown, fallback = 1): number {
  return Math.max(1, toNonNegativeInt(value, fallback));
}

function isThemeMode(value: unknown): value is SessionConfig["themeMode"] {
  return value === "system" || value === "light" || value === "dark";
}

function normalizeSessionConfig(config: unknown): SessionConfig {
  const raw = isObject(config) ? config : {};
  return {
    themeMode: isThemeMode(raw.themeMode) ? raw.themeMode : DEFAULT_SESSION_CONFIG.themeMode,
    postLimit: toPositiveInt(raw.postLimit, DEFAULT_SESSION_CONFIG.postLimit),
    minimalMode: typeof raw.minimalMode === "boolean" ? raw.minimalMode : DEFAULT_SESSION_CONFIG.minimalMode
  };
}

function normalizeDailyLimitsConfig(limits: unknown): DailyLimitsConfig {
  const raw = isObject(limits) ? limits : {};
  const rawGlobal = isObject(raw.global) ? raw.global : {};
  const rawPerSite = isObject(raw.perSite) ? raw.perSite : {};

  const perSite: DailyLimitsConfig["perSite"] = {};
  for (const [siteId, value] of Object.entries(rawPerSite)) {
    if (!isObject(value)) {
      continue;
    }
    perSite[siteId] = {
      maxPosts: toNonNegativeInt(value.maxPosts, 0)
    };
  }

  return {
    global: {
      maxPosts: toNonNegativeInt(rawGlobal.maxPosts, DEFAULT_DAILY_LIMITS.global.maxPosts)
    },
    perSite
  };
}

function normalizeDailyUsage(usage: unknown, dateKey: string): DailyUsage {
  const normalized = normalizeUsageForDate((usage as DailyUsage | null | undefined) ?? null, dateKey);
  return {
    dateKey: normalized.dateKey,
    global: {
      postsViewed: toNonNegativeInt(normalized.global.postsViewed, 0)
    },
    perSite: Object.fromEntries(
      Object.entries(normalized.perSite).map(([siteId, bucket]) => [
        siteId,
        {
          postsViewed: toNonNegativeInt(bucket.postsViewed, 0)
        }
      ])
    )
  };
}

function isPauseReason(value: unknown): value is SessionSnapshot["pauseReason"] {
  return value === null || value === "manual" || value === "details" || value === "navigation" || value === "limit";
}

function isSessionPhase(value: unknown): value is SessionSnapshot["phase"] {
  return value === "idle" || value === "prompting" || value === "active" || value === "paused" || value === "completed";
}

function normalizeSessionSnapshot(snapshot: unknown): SessionSnapshot | null {
  if (!isObject(snapshot)) {
    return null;
  }

  const adapterId = typeof snapshot.adapterId === "string" ? snapshot.adapterId.trim() : "";
  if (!adapterId) {
    return null;
  }

  const rawStats = isObject(snapshot.stats) ? snapshot.stats : {};
  const rawActions = isObject(rawStats.actions) ? rawStats.actions : {};
  const viewedPostIds = Array.isArray(rawStats.viewedPostIds)
    ? Array.from(
        new Set(
          rawStats.viewedPostIds.filter((postId): postId is string => typeof postId === "string" && postId.trim().length > 0)
        )
      )
    : [];

  return {
    phase: isSessionPhase(snapshot.phase) ? snapshot.phase : "idle",
    adapterId,
    config: normalizeSessionConfig(snapshot.config),
    startedAt: toNonNegativeInt(snapshot.startedAt, Date.now()),
    updatedAt: toNonNegativeInt(snapshot.updatedAt, Date.now()),
    focusedPostId: typeof snapshot.focusedPostId === "string" ? snapshot.focusedPostId : null,
    pauseReason: isPauseReason(snapshot.pauseReason) ? snapshot.pauseReason : null,
    stats: {
      viewedCount: viewedPostIds.length,
      viewedPostIds,
      actions: {
        notInterested: toNonNegativeInt(rawActions.notInterested, 0),
        bookmarked: toNonNegativeInt(rawActions.bookmarked, 0),
        openedDetails: toNonNegativeInt(rawActions.openedDetails, 0)
      }
    }
  };
}

function hasChanged(previous: unknown, next: unknown): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

function defaultSiteSettingsFor(siteId: string): SiteSettings {
  if (siteId === "linkedin") {
    return {
      enabled: false,
      suppressPromptDate: ""
    };
  }

  return {
    ...DEFAULT_SITE_SETTINGS
  };
}

export async function getSessionConfig(): Promise<SessionConfig> {
  const stored = await storageGet(STORAGE_KEYS.sessionConfig);
  const normalized = normalizeSessionConfig(stored);
  if (!stored || hasChanged(stored, normalized)) {
    await storageSet({ [STORAGE_KEYS.sessionConfig]: normalized });
  }
  return normalized;
}

export async function updateSessionConfig(partial: Partial<SessionConfig>): Promise<SessionConfig> {
  const next = normalizeSessionConfig({
    ...(await getSessionConfig()),
    ...(partial as Record<string, unknown>)
  });

  await storageSet({
    [STORAGE_KEYS.sessionConfig]: next
  });

  return next;
}

export async function getSessionSnapshot(): Promise<SessionSnapshot | null> {
  const stored = await storageGet(STORAGE_KEYS.sessionSnapshot);
  const normalized = normalizeSessionSnapshot(stored);
  if (!normalized) {
    if (stored) {
      await storageRemove(STORAGE_KEYS.sessionSnapshot);
    }
    return null;
  }

  if (!stored || hasChanged(stored, normalized)) {
    await storageSet({ [STORAGE_KEYS.sessionSnapshot]: normalized });
  }

  return normalized;
}

export async function setSessionSnapshot(snapshot: SessionSnapshot): Promise<void> {
  const normalized = normalizeSessionSnapshot(snapshot);
  if (!normalized) {
    await storageRemove(STORAGE_KEYS.sessionSnapshot);
    return;
  }
  await storageSet({ [STORAGE_KEYS.sessionSnapshot]: normalized });
}

export async function clearSessionSnapshot(): Promise<void> {
  await storageRemove(STORAGE_KEYS.sessionSnapshot);
}

export async function getSiteSettings(siteId: string): Promise<SiteSettings> {
  const map = (await storageGet(STORAGE_KEYS.siteSettings)) ?? {};
  return {
    ...defaultSiteSettingsFor(siteId),
    ...(map[siteId] ?? {})
  };
}

export async function getDailyLimits(): Promise<DailyLimitsConfig> {
  const stored = await storageGet(STORAGE_KEYS.dailyLimits);
  const normalized = normalizeDailyLimitsConfig(stored);
  if (!stored || hasChanged(stored, normalized)) {
    await storageSet({ [STORAGE_KEYS.dailyLimits]: normalized });
  }
  return normalized;
}

export async function setDailyLimits(limits: DailyLimitsConfig): Promise<DailyLimitsConfig> {
  const normalized = normalizeDailyLimitsConfig(limits);

  await storageSet({
    [STORAGE_KEYS.dailyLimits]: normalized
  });

  return normalized;
}

export async function getDailyUsage(): Promise<DailyUsage> {
  const stored = await storageGet(STORAGE_KEYS.dailyUsage);
  const usage = normalizeDailyUsage(stored, nowDateKey());

  if (!stored || hasChanged(stored, usage)) {
    await storageSet({ [STORAGE_KEYS.dailyUsage]: usage });
  }

  return usage;
}

export async function setDailyUsage(usage: DailyUsage): Promise<DailyUsage> {
  const normalized = normalizeDailyUsage(usage, nowDateKey());
  await storageSet({ [STORAGE_KEYS.dailyUsage]: normalized });
  return normalized;
}

export async function clearDailyUsage(): Promise<DailyUsage> {
  const reset = normalizeDailyUsage(null, nowDateKey());
  await storageSet({ [STORAGE_KEYS.dailyUsage]: reset });
  return reset;
}
