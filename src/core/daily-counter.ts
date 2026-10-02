import type { DailyLimitsConfig, DailyUsage, DailyUsageBucket } from "@/types/session";

function emptyBucket(): DailyUsageBucket {
  return {
    postsViewed: 0
  };
}

export function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function millisecondsUntilMidnight(date = new Date()): number {
  const midnight = new Date(date);
  midnight.setHours(24, 0, 0, 0);
  return Math.max(1, midnight.getTime() - date.getTime());
}

function normalizeBucket(value: unknown): DailyUsageBucket {
  const raw = value && typeof value === "object" ? (value as Partial<DailyUsageBucket>).postsViewed : 0;
  const count = Number(raw);
  return { postsViewed: Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0 };
}

export function normalizeUsageForDate(usage: unknown, dateKey: string): DailyUsage {
  const raw = usage && typeof usage === "object" ? usage as Partial<DailyUsage> : null;
  if (!raw || raw.dateKey !== dateKey) {
    return { dateKey, global: emptyBucket(), perSite: {} };
  }

  const perSite = raw.perSite && typeof raw.perSite === "object" ? raw.perSite : {};
  return {
    dateKey,
    global: normalizeBucket(raw.global),
    perSite: Object.fromEntries(Object.entries(perSite).map(([siteId, bucket]) => [siteId, normalizeBucket(bucket)]))
  };
}

export function applyUsageDelta(usage: DailyUsage, siteId: string, delta: { postsViewed?: number }): DailyUsage {
  const postDelta = Math.max(0, Math.floor(delta.postsViewed ?? 0));
  const site = usage.perSite[siteId] ?? emptyBucket();

  return {
    ...usage,
    global: {
      postsViewed: usage.global.postsViewed + postDelta
    },
    perSite: {
      ...usage.perSite,
      [siteId]: {
        postsViewed: site.postsViewed + postDelta
      }
    }
  };
}

export function isDailyLimitReached(limits: DailyLimitsConfig, usage: DailyUsage, siteId: string): boolean {
  const siteUsage = usage.perSite[siteId] ?? emptyBucket();
  const siteLimit = limits.perSite[siteId];

  if (limits.global.maxPosts > 0 && usage.global.postsViewed >= limits.global.maxPosts) {
    return true;
  }

  if (!siteLimit) {
    return false;
  }

  if (siteLimit.maxPosts > 0 && siteUsage.postsViewed >= siteLimit.maxPosts) {
    return true;
  }

  return false;
}
