import { describe, expect, it } from "vitest";
import { resolveSessionStartConfig } from "@/core/session-config";
import type { DailyLimitsConfig, DailyUsage, SessionConfig, SessionSnapshot } from "@/types/session";

const BASE_CONFIG: SessionConfig = {
  mode: "posts",
  themeMode: "system",
  postLimit: 20,
  timeLimitMinutes: 10,
  minimalMode: true
};

const LIMITS: DailyLimitsConfig = {
  global: {
    maxPosts: 12,
    maxMinutes: 0
  },
  perSite: {}
};

const USAGE: DailyUsage = {
  dateKey: "2026-02-21",
  global: {
    postsViewed: 8,
    activeMs: 0,
    emergencyMs: 0
  },
  perSite: {}
};

const RESUME_SNAPSHOT: SessionSnapshot = {
  phase: "paused",
  adapterId: "x",
  config: {
    mode: "posts",
    themeMode: "light",
    postLimit: 10,
    timeLimitMinutes: 7,
    minimalMode: true
  },
  startedAt: 1,
  updatedAt: 2,
  focusedPostId: "x-status-1",
  pauseReason: "navigation",
  stats: {
    viewedCount: 4,
    viewedPostIds: ["1", "2", "3", "4"],
    activeMs: 20_000,
    actions: {
      notInterested: 0,
      bookmarked: 1,
      openedDetails: 0
    }
  }
};

describe("resolveSessionStartConfig", () => {
  it("caps fresh post sessions by remaining daily posts", () => {
    const resolved = resolveSessionStartConfig(BASE_CONFIG, {}, null, LIMITS, USAGE);
    expect(resolved.resumed).toBe(false);
    expect(resolved.cappedByDailyLimit).toBe(true);
    expect(resolved.remainingPosts).toBe(4);
    expect(resolved.config.postLimit).toBe(4);
  });

  it("does not cap fresh time sessions", () => {
    const resolved = resolveSessionStartConfig(BASE_CONFIG, { mode: "time", timeLimitMinutes: 5 }, null, LIMITS, USAGE);
    expect(resolved.cappedByDailyLimit).toBe(false);
    expect(resolved.config.mode).toBe("time");
    expect(resolved.config.timeLimitMinutes).toBe(5);
    expect(resolved.config.postLimit).toBe(20);
  });

  it("resumes exact snapshot config without recapping limits", () => {
    const resolved = resolveSessionStartConfig(BASE_CONFIG, {}, RESUME_SNAPSHOT, LIMITS, USAGE);
    expect(resolved.resumed).toBe(true);
    expect(resolved.cappedByDailyLimit).toBe(false);
    expect(resolved.config.postLimit).toBe(10);
    expect(resolved.config.timeLimitMinutes).toBe(7);
    expect(resolved.config.themeMode).toBe("light");
  });

  it("applies overrides on top of resumed snapshot config", () => {
    const resolved = resolveSessionStartConfig(BASE_CONFIG, { themeMode: "dark", minimalMode: false }, RESUME_SNAPSHOT, LIMITS, USAGE);
    expect(resolved.resumed).toBe(true);
    expect(resolved.config.postLimit).toBe(10);
    expect(resolved.config.themeMode).toBe("dark");
    expect(resolved.config.minimalMode).toBe(false);
  });
});
