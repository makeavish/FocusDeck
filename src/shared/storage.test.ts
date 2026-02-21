import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "@/shared/constants";
import {
  getDailyLimits,
  getDailyUsage,
  getSessionConfig,
  getSessionSnapshot,
  setDailyLimits,
  setDailyUsage,
  updateSessionConfig
} from "@/shared/storage";

const mocks = vi.hoisted(() => {
  const store: Record<string, unknown> = {};
  return {
    store,
    get: vi.fn(async (key: string) => ({ [key]: store[key] })),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(store, values);
    }),
    remove: vi.fn(async (key: string) => {
      delete store[key];
    })
  };
});

vi.mock("@/shared/browser-polyfill", () => ({
  browserApi: {
    storage: {
      local: {
        get: mocks.get,
        set: mocks.set,
        remove: mocks.remove
      }
    }
  }
}));

function todayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const LEGACY_TIME_LIMIT_KEY = `timeLimit${"Minutes"}`;
const LEGACY_MAX_LIMIT_KEY = `max${"Minutes"}`;
const LEGACY_ACTIVE_KEY = `active${"Ms"}`;
const LEGACY_EMERGENCY_KEY = `emergency${"Ms"}`;

describe("shared/storage migration sanitization", () => {
  beforeEach(() => {
    for (const key of Object.keys(mocks.store)) {
      delete mocks.store[key];
    }
    mocks.get.mockClear();
    mocks.set.mockClear();
    mocks.remove.mockClear();
  });

  it("strips legacy time fields from session config while preserving post values", async () => {
    mocks.store[STORAGE_KEYS.sessionConfig] = {
      mode: "time",
      themeMode: "dark",
      postLimit: 17,
      [LEGACY_TIME_LIMIT_KEY]: 12,
      minimalMode: false
    };

    const config = await getSessionConfig();

    expect(config).toEqual({
      themeMode: "dark",
      postLimit: 17,
      minimalMode: false
    });
    expect(mocks.store[STORAGE_KEYS.sessionConfig]).toEqual(config);
  });

  it("normalizes invalid post limit to a positive value", async () => {
    await updateSessionConfig({ postLimit: 0 });
    const config = await getSessionConfig();
    expect(config.postLimit).toBe(1);
  });

  it("strips minute limits from daily limits on read and write", async () => {
    mocks.store[STORAGE_KEYS.dailyLimits] = {
      global: { maxPosts: 11, [LEGACY_MAX_LIMIT_KEY]: 30 },
      perSite: {
        x: { maxPosts: 4, [LEGACY_MAX_LIMIT_KEY]: 10 }
      }
    };

    const loaded = await getDailyLimits();
    expect(loaded).toEqual({
      global: { maxPosts: 11 },
      perSite: {
        x: { maxPosts: 4 }
      }
    });

    const saved = await setDailyLimits({
      global: { maxPosts: 7 },
      perSite: { x: { maxPosts: 3 } }
    });
    expect(saved).toEqual({
      global: { maxPosts: 7 },
      perSite: { x: { maxPosts: 3 } }
    });
    expect(mocks.store[STORAGE_KEYS.dailyLimits]).toEqual(saved);
  });

  it("strips legacy usage minute fields while preserving post counters", async () => {
    mocks.store[STORAGE_KEYS.dailyUsage] = {
      dateKey: todayKey(),
      global: { postsViewed: 9, [LEGACY_ACTIVE_KEY]: 120_000, [LEGACY_EMERGENCY_KEY]: 60_000 },
      perSite: {
        x: { postsViewed: 4, [LEGACY_ACTIVE_KEY]: 40_000, [LEGACY_EMERGENCY_KEY]: 20_000 }
      }
    };

    const usage = await getDailyUsage();

    expect(usage.global.postsViewed).toBe(9);
    expect(usage.perSite.x.postsViewed).toBe(4);
    expect(mocks.store[STORAGE_KEYS.dailyUsage]).toEqual(usage);

    const nextUsage = await setDailyUsage({
      dateKey: todayKey(),
      global: { postsViewed: 10 },
      perSite: { x: { postsViewed: 5 } }
    });
    expect(nextUsage).toEqual({
      dateKey: todayKey(),
      global: { postsViewed: 10 },
      perSite: { x: { postsViewed: 5 } }
    });
  });

  it("strips legacy time fields from stored session snapshots", async () => {
    mocks.store[STORAGE_KEYS.sessionSnapshot] = {
      phase: "paused",
      adapterId: "x",
      config: {
        mode: "time",
        themeMode: "light",
        postLimit: 8,
        [LEGACY_TIME_LIMIT_KEY]: 5,
        minimalMode: true
      },
      startedAt: 100,
      updatedAt: 200,
      focusedPostId: "x-post-1",
      pauseReason: "navigation",
      stats: {
        viewedCount: 1,
        viewedPostIds: ["a", "b"],
        [LEGACY_ACTIVE_KEY]: 10_000,
        actions: {
          notInterested: 1,
          bookmarked: 2,
          openedDetails: 0
        }
      }
    };

    const snapshot = await getSessionSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.config).toEqual({
      themeMode: "light",
      postLimit: 8,
      minimalMode: true
    });
    expect(snapshot?.stats.viewedPostIds).toEqual(["a", "b"]);
    expect(snapshot?.stats.viewedCount).toBe(2);
    expect(mocks.store[STORAGE_KEYS.sessionSnapshot]).toEqual(snapshot);
  });
});
