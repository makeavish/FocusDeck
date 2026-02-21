import { describe, expect, it } from "vitest";
import { resolveSessionStartConfig } from "@/core/session-config";
import type { DailyLimitsConfig, DailyUsage, SessionConfig, SessionSnapshot } from "@/types/session";

const BASE_CONFIG: SessionConfig = {
  themeMode: "system",
  postLimit: 20,
  minimalMode: true
};

const LIMITS: DailyLimitsConfig = {
  global: {
    maxPosts: 12
  },
  perSite: {}
};

const USAGE: DailyUsage = {
  dateKey: "2026-02-21",
  global: {
    postsViewed: 8
  },
  perSite: {}
};

const RESUME_SNAPSHOT: SessionSnapshot = {
  phase: "paused",
  adapterId: "x",
  config: {
    themeMode: "light",
    postLimit: 10,
    minimalMode: true
  },
  startedAt: 1,
  updatedAt: 2,
  focusedPostId: "x-status-1",
  pauseReason: "navigation",
  stats: {
    viewedCount: 4,
    viewedPostIds: ["1", "2", "3", "4"],
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

  it("resumes exact snapshot config without recapping limits", () => {
    const resolved = resolveSessionStartConfig(BASE_CONFIG, {}, RESUME_SNAPSHOT, LIMITS, USAGE);
    expect(resolved.resumed).toBe(true);
    expect(resolved.cappedByDailyLimit).toBe(false);
    expect(resolved.config.postLimit).toBe(10);
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
