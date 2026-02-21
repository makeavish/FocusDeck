import { describe, expect, it } from "vitest";
import { applyUsageDelta, isDailyLimitReached, normalizeUsageForDate } from "@/core/daily-counter";
import type { DailyLimitsConfig } from "@/types/session";

const LIMITS: DailyLimitsConfig = {
  global: {
    maxPosts: 10
  },
  perSite: {
    x: {
      maxPosts: 5
    }
  }
};

describe("daily-counter", () => {
  it("normalizes empty usage for date", () => {
    const usage = normalizeUsageForDate(null, "2026-02-15");
    expect(usage.dateKey).toBe("2026-02-15");
    expect(usage.global.postsViewed).toBe(0);
    expect(Object.keys(usage.perSite)).toHaveLength(0);
  });

  it("resets usage when date changes", () => {
    const usage = normalizeUsageForDate(
      {
        dateKey: "2026-02-14",
        global: { postsViewed: 4 },
        perSite: { x: { postsViewed: 3 } }
      },
      "2026-02-15"
    );

    expect(usage.dateKey).toBe("2026-02-15");
    expect(usage.global.postsViewed).toBe(0);
    expect(usage.perSite.x).toBeUndefined();
  });

  it("applies usage deltas globally and per-site", () => {
    const base = normalizeUsageForDate(null, "2026-02-15");
    const usage = applyUsageDelta(base, "x", { postsViewed: 2 });
    expect(usage.global.postsViewed).toBe(2);
    expect(usage.perSite.x.postsViewed).toBe(2);
  });

  it("detects global and site limits", () => {
    let usage = normalizeUsageForDate(null, "2026-02-15");
    usage = applyUsageDelta(usage, "x", { postsViewed: 5 });
    expect(isDailyLimitReached(LIMITS, usage, "x")).toBe(true);

    usage = normalizeUsageForDate(null, "2026-02-15");
    usage = applyUsageDelta(usage, "x", { postsViewed: 10 });
    expect(isDailyLimitReached(LIMITS, usage, "x")).toBe(true);
  });
});
