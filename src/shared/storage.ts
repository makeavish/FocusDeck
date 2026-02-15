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
  return {
    ...DEFAULT_SESSION_CONFIG,
    ...(stored ?? {})
  };
}

export async function updateSessionConfig(partial: Partial<SessionConfig>): Promise<SessionConfig> {
  const next = {
    ...(await getSessionConfig()),
    ...partial
  };

  await storageSet({
    [STORAGE_KEYS.sessionConfig]: next
  });

  return next;
}

export async function getSessionSnapshot(): Promise<SessionSnapshot | null> {
  const stored = await storageGet(STORAGE_KEYS.sessionSnapshot);
  return stored ?? null;
}

export async function setSessionSnapshot(snapshot: SessionSnapshot): Promise<void> {
  await storageSet({ [STORAGE_KEYS.sessionSnapshot]: snapshot });
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
  return {
    ...DEFAULT_DAILY_LIMITS,
    ...(stored ?? {}),
    global: {
      ...DEFAULT_DAILY_LIMITS.global,
      ...(stored?.global ?? {})
    }
  };
}

export async function setDailyLimits(limits: DailyLimitsConfig): Promise<DailyLimitsConfig> {
  const normalized: DailyLimitsConfig = {
    global: {
      maxPosts: Math.max(0, Math.floor(limits.global.maxPosts || 0)),
      maxMinutes: Math.max(0, Math.floor(limits.global.maxMinutes || 0))
    },
    perSite: { ...limits.perSite }
  };

  await storageSet({
    [STORAGE_KEYS.dailyLimits]: normalized
  });

  return normalized;
}

export async function getDailyUsage(): Promise<DailyUsage> {
  const stored = await storageGet(STORAGE_KEYS.dailyUsage);
  const usage = normalizeUsageForDate(stored ?? null, nowDateKey());

  if (!stored || stored.dateKey !== usage.dateKey) {
    await storageSet({ [STORAGE_KEYS.dailyUsage]: usage });
  }

  return usage;
}

export async function setDailyUsage(usage: DailyUsage): Promise<DailyUsage> {
  const normalized = normalizeUsageForDate(usage, nowDateKey());
  await storageSet({ [STORAGE_KEYS.dailyUsage]: normalized });
  return normalized;
}

export async function clearDailyUsage(): Promise<DailyUsage> {
  const reset = normalizeUsageForDate(null, nowDateKey());
  await storageSet({ [STORAGE_KEYS.dailyUsage]: reset });
  return reset;
}
