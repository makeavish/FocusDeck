import { describe, expect, it } from "vitest";
import { applyUsageDelta, isDailyLimitReached, normalizeUsageForDate } from "@/core/daily-counter";
import type { DailyLimitsConfig } from "@/types/session";

const LIMITS: DailyLimitsConfig = {
  global: {
    maxPosts: 10,
    maxMinutes: 20
  },
  perSite: {
    x: {
      maxPosts: 5,
      maxMinutes: 8
    }
  }
};

describe("daily-counter", () => {
  it("normalizes empty usage for date", () => {
    const usage = normalizeUsageForDate(null, "2026-02-15");
    expect(usage.dateKey).toBe("2026-02-15");
    expect(usage.global.postsViewed).toBe(0);
    expect(usage.global.activeMs).toBe(0);
    expect(Object.keys(usage.perSite)).toHaveLength(0);
  });

  it("resets usage when date changes", () => {
    const usage = normalizeUsageForDate(
      {
        dateKey: "2026-02-14",
        global: { postsViewed: 4, activeMs: 120_000, emergencyMs: 0 },
        perSite: { x: { postsViewed: 3, activeMs: 90_000, emergencyMs: 0 } }
      },
      "2026-02-15"
    );

    expect(usage.dateKey).toBe("2026-02-15");
    expect(usage.global.postsViewed).toBe(0);
    expect(usage.perSite.x).toBeUndefined();
  });

  it("applies usage deltas globally and per-site", () => {
    const base = normalizeUsageForDate(null, "2026-02-15");
    const usage = applyUsageDelta(base, "x", { postsViewed: 2, activeMs: 30_000 });
    expect(usage.global.postsViewed).toBe(2);
    expect(usage.global.activeMs).toBe(30_000);
    expect(usage.perSite.x.postsViewed).toBe(2);
    expect(usage.perSite.x.activeMs).toBe(30_000);
  });

  it("detects global and site limits", () => {
    let usage = normalizeUsageForDate(null, "2026-02-15");
    usage = applyUsageDelta(usage, "x", { postsViewed: 5 });
    expect(isDailyLimitReached(LIMITS, usage, "x")).toBe(true);

    usage = normalizeUsageForDate(null, "2026-02-15");
    usage = applyUsageDelta(usage, "x", { postsViewed: 2, activeMs: 9 * 60_000 });
    expect(isDailyLimitReached(LIMITS, usage, "x")).toBe(true);
  });

  it("accounts for emergency override minutes", () => {
    let usage = normalizeUsageForDate(null, "2026-02-15");
    usage = applyUsageDelta(usage, "x", { activeMs: 10 * 60_000 });
    expect(isDailyLimitReached(LIMITS, usage, "x")).toBe(true);

    usage = applyUsageDelta(usage, "x", { emergencyMs: 3 * 60_000 });
    expect(isDailyLimitReached(LIMITS, usage, "x")).toBe(false);
  });
});

