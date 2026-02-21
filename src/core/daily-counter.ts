import type { DailyLimitsConfig, DailyUsage, DailyUsageBucket } from "@/types/session";

function emptyBucket(): DailyUsageBucket {
  return {
    postsViewed: 0
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
      postsViewed: Math.max(0, Math.floor(usage.global.postsViewed))
    },
    perSite: Object.fromEntries(
      Object.entries(usage.perSite).map(([siteId, bucket]) => [
        siteId,
        {
          postsViewed: Math.max(0, Math.floor(bucket.postsViewed))
        }
      ])
    )
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
