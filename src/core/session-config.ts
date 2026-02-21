import type { DailyLimitsConfig, DailyUsage, SessionConfig, SessionSnapshot } from "@/types/session";

export interface ResolvedSessionStartConfig {
  config: SessionConfig;
  resumed: boolean;
  cappedByDailyLimit: boolean;
  remainingPosts: number | null;
}

export function resolveSessionStartConfig(
  baseConfig: SessionConfig,
  overrides: Partial<SessionConfig>,
  resumeSnapshot: SessionSnapshot | null | undefined,
  dailyLimits: DailyLimitsConfig,
  dailyUsage: DailyUsage
): ResolvedSessionStartConfig {
  const resumed = Boolean(resumeSnapshot);
  const sourceConfig = resumed && resumeSnapshot ? resumeSnapshot.config : baseConfig;
  const nextConfig: SessionConfig = {
    ...sourceConfig,
    ...overrides
  };

  const remainingPosts =
    dailyLimits.global.maxPosts > 0 ? Math.max(0, dailyLimits.global.maxPosts - dailyUsage.global.postsViewed) : null;

  let cappedByDailyLimit = false;
  if (!resumed && nextConfig.mode === "posts" && remainingPosts !== null && remainingPosts > 0 && nextConfig.postLimit > remainingPosts) {
    nextConfig.postLimit = remainingPosts;
    cappedByDailyLimit = true;
  }

  return {
    config: nextConfig,
    resumed,
    cappedByDailyLimit,
    remainingPosts
  };
}
