import type { DailyLimitsConfig, DailyUsage, DailyUsageBucket } from "@/types/session";

function emptyBucket(): DailyUsageBucket {
  return {
    postsViewed: 0,
    activeMs: 0,
    emergencyMs: 0
  };
}

export function normalizeUsageForDate(usage: DailyUsage | null, dateKey: string): DailyUsage {
  if (!usage || usage.dateKey !== dateKey) {
    return {
      dateKey,
      global: emptyBucket(),
      perSite: {}
    };
  }

  return {
    dateKey: usage.dateKey,
    global: {
      postsViewed: Math.max(0, Math.floor(usage.global.postsViewed)),
      activeMs: Math.max(0, Math.floor(usage.global.activeMs)),
      emergencyMs: Math.max(0, Math.floor(usage.global.emergencyMs))
    },
    perSite: Object.fromEntries(
      Object.entries(usage.perSite).map(([siteId, bucket]) => [
        siteId,
        {
          postsViewed: Math.max(0, Math.floor(bucket.postsViewed)),
          activeMs: Math.max(0, Math.floor(bucket.activeMs)),
          emergencyMs: Math.max(0, Math.floor(bucket.emergencyMs))
        }
      ])
    )
  };
}

export function applyUsageDelta(
  usage: DailyUsage,
  siteId: string,
  delta: { postsViewed?: number; activeMs?: number; emergencyMs?: number }
): DailyUsage {
  const postDelta = Math.max(0, Math.floor(delta.postsViewed ?? 0));
  const activeDelta = Math.max(0, Math.floor(delta.activeMs ?? 0));
  const emergencyDelta = Math.max(0, Math.floor(delta.emergencyMs ?? 0));
  const site = usage.perSite[siteId] ?? emptyBucket();

  return {
    ...usage,
    global: {
      postsViewed: usage.global.postsViewed + postDelta,
      activeMs: usage.global.activeMs + activeDelta,
      emergencyMs: usage.global.emergencyMs + emergencyDelta
    },
    perSite: {
      ...usage.perSite,
      [siteId]: {
        postsViewed: site.postsViewed + postDelta,
        activeMs: site.activeMs + activeDelta,
        emergencyMs: site.emergencyMs + emergencyDelta
      }
    }
  };
}

export function isDailyLimitReached(limits: DailyLimitsConfig, usage: DailyUsage, siteId: string): boolean {
  const siteUsage = usage.perSite[siteId] ?? emptyBucket();
  const siteLimit = limits.perSite[siteId];
  const globalEffectiveMs = Math.max(0, usage.global.activeMs - usage.global.emergencyMs);
  const siteEffectiveMs = Math.max(0, siteUsage.activeMs - siteUsage.emergencyMs);

  if (limits.global.maxPosts > 0 && usage.global.postsViewed >= limits.global.maxPosts) {
    return true;
  }

  if (limits.global.maxMinutes > 0 && globalEffectiveMs >= limits.global.maxMinutes * 60_000) {
    return true;
  }

  if (!siteLimit) {
    return false;
  }

  if (siteLimit.maxPosts > 0 && siteUsage.postsViewed >= siteLimit.maxPosts) {
    return true;
  }

  if (siteLimit.maxMinutes > 0 && siteEffectiveMs >= siteLimit.maxMinutes * 60_000) {
    return true;
  }

  return false;
}
