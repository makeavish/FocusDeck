export type ThemeMode = "system" | "light" | "dark";

export type SessionPhase = "idle" | "prompting" | "active" | "paused" | "completed";

export type PauseReason = "manual" | "details" | "navigation" | "limit" | null;

export interface SessionConfig {
  themeMode: ThemeMode;
  postLimit: number;
  minimalMode: boolean;
}

export interface SessionStats {
  viewedCount: number;
  viewedPostIds: string[];
  actions: {
    notInterested: number;
    bookmarked: number;
    openedDetails: number;
  };
}

export interface SessionSnapshot {
  phase: SessionPhase;
  adapterId: string;
  config: SessionConfig;
  startedAt: number;
  updatedAt: number;
  focusedPostId: string | null;
  pauseReason: PauseReason;
  stats: SessionStats;
}

export interface SessionSummary {
  reason: "posts-limit" | "manual";
  viewedCount: number;
  durationMs: number;
}

export interface DailyLimitRule {
  maxPosts: number;
}

export interface DailyLimitsConfig {
  global: DailyLimitRule;
  perSite: Record<string, DailyLimitRule>;
}

export interface DailyUsageBucket {
  postsViewed: number;
}

export interface DailyUsage {
  dateKey: string;
  global: DailyUsageBucket;
  perSite: Record<string, DailyUsageBucket>;
}
