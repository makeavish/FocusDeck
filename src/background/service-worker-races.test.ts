import { beforeEach, describe, expect, it, vi } from "vitest";
import * as storage from "@/shared/storage";
import { browserApi } from "@/shared/browser-polyfill";
import { localDateKey } from "@/core/daily-counter";
import { STORAGE_KEYS } from "@/shared/constants";
import type { RuntimeMessage, RuntimeResponse, DailyViewResult } from "@/types/messages";
import type { SessionSnapshot } from "@/types/session";

const mocks = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  tabs: [{ id: 1 }, { id: 2 }] as { id: number }[],
  tabUpdated: null as ((tabId: number, change: { status?: string; discarded?: boolean; url?: string; audible?: boolean }) => void) | null,
  listener: null as ((message: RuntimeMessage, sender: { tab?: { id: number } }) => Promise<RuntimeResponse> | RuntimeResponse) | null
}));

vi.mock("@/shared/browser-polyfill", () => {
  const area = (store: Record<string, unknown>) => ({
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(store[key])]))),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(store, structuredClone(values)); }),
    remove: vi.fn(async (key: string) => { delete store[key]; })
  });
  return { browserApi: {
    storage: { local: area(mocks.store), session: area(mocks.session) },
    runtime: {
      onMessage: { addListener: (listener: typeof mocks.listener) => { mocks.listener = listener; } },
      onInstalled: { addListener: vi.fn() }
    },
    action: { onClicked: { addListener: vi.fn() } },
    tabs: { query: vi.fn(async () => mocks.tabs), onUpdated: { addListener: (listener: typeof mocks.tabUpdated) => { mocks.tabUpdated = listener; } } }
  } };
});

await import("./service-worker");

function send<T>(message: RuntimeMessage, tabId?: number): Promise<RuntimeResponse<T>> {
  return Promise.resolve(mocks.listener!(message, tabId === undefined ? {} : { tab: { id: tabId } })) as Promise<RuntimeResponse<T>>;
}
const snapshot: SessionSnapshot = {
  sessionId: "session-a", adapterId: "x", phase: "paused", pauseReason: "details", focusedPostId: "x-status-10",
  config: { themeMode: "system", postLimit: 20, minimalMode: true }, startedAt: 1, updatedAt: 2,
  stats: { viewedCount: 1, viewedPostIds: ["10"], actions: { bookmarked: 0, notInterested: 0, openedDetails: 0 } }
};
async function open(tabId = 1, ownerToken = `owner-${tabId}`) {
  await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken }, tabId);
  const saved = await send<SessionSnapshot>({ type: "focusdeck:save-session", ownerToken, snapshot: {
    ...snapshot, sessionId: `session-${tabId}`, phase: "active", focusedPostId: null,
    stats: { ...snapshot.stats, viewedCount: 0, viewedPostIds: [] }
  } }, tabId);
  expect(saved.ok).toBe(true);
  return saved.data!;
}
function view(tabId = 1, key = "a", requestId: string = crypto.randomUUID(), ownerToken = `owner-${tabId}`) {
  return { ownerToken, sessionId: `session-${tabId}`, requestId, progressKey: key, postId: `x-status-${key}` };
}
async function record(tabId = 1, key = "a") {
  const request = view(tabId, key);
  const reservation = await send<DailyViewResult>({ type: "focusdeck:reserve-view", ...request }, tabId);
  if (!reservation.data?.allowed) return reservation;
  const committed = await send<DailyViewResult>({ type: "focusdeck:commit-view", ...request }, tabId);
  await send({ type: "focusdeck:ack-view", ...request }, tabId);
  return committed;
}
async function usage() { return (await send<DailyViewResult["usage"]>({ type: "focusdeck:get-daily-usage" })).data!; }
async function restart() { vi.resetModules(); await import("./service-worker"); }

describe("worker view transactions and recoverable session ownership", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const store of [mocks.store, mocks.session]) for (const key of Object.keys(store)) delete store[key];
    mocks.store[STORAGE_KEYS.dailyLimits] = { global: { maxPosts: 100 }, perSite: {} };
    mocks.tabs = [{ id: 1 }, { id: 2 }];
  });

  it("atomically accumulates simultaneous views from different tabs", async () => {
    await open(1); await open(2);
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => record(index % 2 + 1, String(index))));
    expect(results.every((result) => result.data?.allowed)).toBe(true);
    expect((await usage()).global.postsViewed).toBe(5);
    expect((await usage()).perSite.x.postsViewed).toBe(5);
  });

  it("reserves the last allowance for only one live tab", async () => {
    await open(1); await open(2);
    mocks.store[STORAGE_KEYS.dailyLimits] = { global: { maxPosts: 1 }, perSite: {} };
    const results = await Promise.all([1, 2].map((tabId) => send<DailyViewResult>({ type: "focusdeck:reserve-view", ...view(tabId) }, tabId)));
    expect(results.map((result) => result.data?.allowed)).toEqual([true, false]);
    expect((await usage()).global.postsViewed).toBe(0);
  });

  it("commits keys and usage in one write and deduplicates retries after reload", async () => {
    const saved = await open();
    await record(1, "a");
    const request = view(1, "b");
    await send({ type: "focusdeck:reserve-view", ...request }, 1);
    await send({ type: "focusdeck:commit-view", ...request }, 1);
    const writes = vi.mocked(browserApi.storage.local.set).mock.calls.map(([data]) => data as Record<string, unknown>);
    expect(writes.some((data) => (data[STORAGE_KEYS.dailyUsage] as DailyViewResult["usage"] | undefined)?.global.postsViewed === 2 &&
      (data[STORAGE_KEYS.sessionSnapshots] as Record<string, { snapshot: SessionSnapshot }> | undefined)?.[saved.sessionId!].snapshot.stats.viewedPostIds.join() === "a,b")).toBe(true);
    // A delayed presentation save cannot roll counted progress back.
    await send({ type: "focusdeck:save-session", ownerToken: "owner-1", snapshot: saved }, 1);
    const recovered = await send<SessionSnapshot>({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "new" }, 1);
    expect(recovered.data?.stats.viewedPostIds).toEqual(["a", "b"]);
    await send({ type: "focusdeck:reserve-view", ...view(1, "b", "retry", "new") }, 1);
    await send({ type: "focusdeck:commit-view", ...view(1, "b", "retry", "new") }, 1);
    expect((await usage()).global.postsViewed).toBe(2);
    expect((await send({ type: "focusdeck:release-view", ...request }, 1)).ok).toBe(false);
  });

  it.each([false, true])("releases a cancelled request (committed=%s) exactly once", async (committed) => {
    await open();
    await record(1, "a");
    const request = view(1, "b");
    await send({ type: "focusdeck:reserve-view", ...request }, 1);
    if (committed) await send({ type: "focusdeck:commit-view", ...request }, 1);
    await send({ type: "focusdeck:release-view", ...request }, 1);
    await send({ type: "focusdeck:release-view", ...request }, 1);
    expect((await usage()).global.postsViewed).toBe(1);
    const recovered = await send<SessionSnapshot>({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "new" }, 1);
    expect(recovered.data?.stats.viewedPostIds).toEqual(["a"]);
    await send({ type: "focusdeck:reserve-view", ...view(1, "b", "retry", "new") }, 1);
    await send({ type: "focusdeck:commit-view", ...view(1, "b", "retry", "new") }, 1);
    expect((await usage()).global.postsViewed).toBe(2);
  });

  it("does not refund an applied view", async () => {
    await open(); const request = view();
    for (const type of ["focusdeck:reserve-view", "focusdeck:commit-view", "focusdeck:ack-view", "focusdeck:release-view"] as const) await send({ type, ...request }, 1);
    expect((await usage()).global.postsViewed).toBe(1);
  });

  it("does not double-charge duplicate commits and protects a reconciled retry from stale cancellation", async () => {
    await open(); const request = view();
    await send({ type: "focusdeck:reserve-view", ...request }, 1);
    const results = await Promise.all([1, 2].map(() => send<DailyViewResult>({ type: "focusdeck:commit-view", ...request }, 1)));
    expect(results.map((result) => result.data?.usage.global.postsViewed)).toEqual([1, 1]);
    const retry = view(1, "a", "retry");
    await send({ type: "focusdeck:reserve-view", ...retry }, 1);
    await send({ type: "focusdeck:commit-view", ...retry }, 1);
    await send({ type: "focusdeck:ack-view", ...retry }, 1);
    await send({ type: "focusdeck:release-view", ...request }, 1);
    expect((await usage()).global.postsViewed).toBe(1);
    const recovered = await send<SessionSnapshot>({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "new" }, 1);
    expect(recovered.data?.stats.viewedPostIds).toEqual(["a"]);
  });

  it("commits a pending pre-midnight reservation against the new day's allowance", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 2, 23, 59, 59));
    await open(); const request = view();
    await send({ type: "focusdeck:reserve-view", ...request }, 1);
    vi.setSystemTime(new Date(2026, 9, 3, 0, 0, 1));
    const result = await send<DailyViewResult>({ type: "focusdeck:commit-view", ...request }, 1);
    expect(result.data?.usage.dateKey).toBe(localDateKey());
    expect(result.data?.usage.global.postsViewed).toBe(1);
    expect(result.data?.snapshot?.stats.viewedPostIds).toEqual(["a"]);
    vi.useRealTimers();
  });

  it("retains the charge and key when commit responses are lost and the worker restarts", async () => {
    await open(); const request = view();
    await send({ type: "focusdeck:reserve-view", ...request }, 1);
    await send({ type: "focusdeck:commit-view", ...request }, 1);
    await restart();
    await send({ type: "focusdeck:commit-view", ...request }, 1);
    expect((await usage()).global.postsViewed).toBe(1);
    await send({ type: "focusdeck:release-view", ...request }, 1);
    expect((await usage()).global.postsViewed).toBe(0);
  });

  it("preserves pending reservations across worker restart but revokes them on document reload", async () => {
    await open(1); await open(2);
    mocks.store[STORAGE_KEYS.dailyLimits] = { global: { maxPosts: 1 }, perSite: {} };
    await send({ type: "focusdeck:reserve-view", ...view() }, 1);
    await restart();
    expect((await send<DailyViewResult>({ type: "focusdeck:reserve-view", ...view(2) }, 2)).data?.allowed).toBe(false);
    await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "new" }, 1);
    expect((await send<DailyViewResult>({ type: "focusdeck:reserve-view", ...view(2) }, 2)).data?.allowed).toBe(true);
  });

  it("does not lose keys or charges on a failed atomic commit", async () => {
    await open(); const request = view();
    await send({ type: "focusdeck:reserve-view", ...request }, 1);
    vi.mocked(browserApi.storage.local.set).mockRejectedValueOnce(new Error("write failed"));
    expect((await send({ type: "focusdeck:commit-view", ...request }, 1)).ok).toBe(false);
    expect((await usage()).global.postsViewed).toBe(0);
    expect((await send<DailyViewResult>({ type: "focusdeck:commit-view", ...request }, 1)).data?.snapshot?.stats.viewedPostIds).toEqual(["a"]);
    expect((await usage()).global.postsViewed).toBe(1);
  });

  it("rechecks limit edits at commit and allows new requests after reset", async () => {
    await open(); const request = view();
    await send({ type: "focusdeck:reserve-view", ...request }, 1);
    await send({ type: "focusdeck:set-daily-limits", payload: { global: { maxPosts: 1 }, perSite: {} } });
    await storage.setDailyUsage({ dateKey: localDateKey(), global: { postsViewed: 1 }, perSite: {} });
    expect((await send<DailyViewResult>({ type: "focusdeck:commit-view", ...request }, 1)).data?.allowed).toBe(false);
    await send({ type: "focusdeck:clear-daily-usage" });
    expect((await record()).data?.allowed).toBe(true);
    expect((await record(1, "b")).data?.allowed).toBe(false);
  });

  it("does not refund old charges from the reset allowance", async () => {
    await open(1); await open(2); const request = view();
    await send({ type: "focusdeck:reserve-view", ...request }, 1);
    await send({ type: "focusdeck:commit-view", ...request }, 1);
    await send({ type: "focusdeck:clear-daily-usage" });
    await record(2);
    await send({ type: "focusdeck:release-view", ...request }, 1);
    expect((await usage()).global.postsViewed).toBe(1);
  });

  it("rolls over a reservation at midnight and never refunds yesterday from today", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 2, 23, 59, 59));
    await open(1); await open(2); const request = view();
    await send({ type: "focusdeck:reserve-view", ...request }, 1);
    await send({ type: "focusdeck:commit-view", ...request }, 1);
    vi.setSystemTime(new Date(2026, 9, 3, 0, 0, 1));
    await record(2);
    await send({ type: "focusdeck:release-view", ...request }, 1);
    expect((await usage()).global.postsViewed).toBe(1);
    expect((await usage()).dateKey).toBe(localDateKey());
    vi.useRealTimers();
  });

  it("normalizes usage if midnight passes while reading it", async () => {
    await open(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 2, 23, 59, 59));
    const oldUsage = { dateKey: localDateKey(), global: { postsViewed: 100 }, perSite: {} };
    const read = vi.spyOn(storage, "getDailyUsage").mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(2026, 9, 3, 0, 0, 1)); return oldUsage;
    });
    expect((await record()).data?.usage.global.postsViewed).toBe(1);
    read.mockRestore(); vi.useRealTimers();
  });

  it("does not let live tabs adopt, overwrite or delete another session", async () => {
    await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "a" }, 1);
    await send({ type: "focusdeck:save-session", ownerToken: "a", snapshot }, 1);
    expect((await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "b" }, 2)).data).toBeNull();
    expect((await send({ type: "focusdeck:save-session", ownerToken: "a", snapshot }, 2)).ok).toBe(false);
    await send({ type: "focusdeck:clear-owned-session", ownerToken: "b" }, 2);
    expect((await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "a" }, 1)).data).toEqual(snapshot);
  });

  it("recovers closed-tab sessions and revokes stale documents", async () => {
    await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "a" }, 1);
    await send({ type: "focusdeck:save-session", ownerToken: "a", snapshot }, 1);
    mocks.tabs = [{ id: 2 }];
    expect((await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "b" }, 2)).data).toEqual(snapshot);
    expect((await send({ type: "focusdeck:save-session", ownerToken: "a", snapshot }, 1)).ok).toBe(false);
    await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "new" }, 2);
    await send({ type: "focusdeck:clear-owned-session", ownerToken: "b" }, 2);
    expect((await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "new" }, 2)).data).toEqual(snapshot);
  });

  it("recovers after browser restart regardless of numeric tab ID collisions", async () => {
    const first = await open(1); await record(1); const second = await open(2); await record(2, "b");
    await send({ type: "focusdeck:save-session", ownerToken: "owner-1", snapshot: { ...first, updatedAt: 10 } }, 1);
    await send({ type: "focusdeck:save-session", ownerToken: "owner-2", snapshot: { ...second, updatedAt: 20 } }, 2);
    for (const key of Object.keys(mocks.session)) delete mocks.session[key];
    await restart();
    mocks.tabs = [{ id: 1 }, { id: 2 }, { id: 9 }];
    // Reused ID 1 cannot select its former session; recovery selects the newest unleased snapshot.
    const recovered = await send<SessionSnapshot>({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "restart" }, 1);
    expect(recovered.data?.sessionId).toBe("session-2");
    // An unrelated live tab with reused ID 2 cannot prevent closed-session recovery either.
    const remaining = await send<SessionSnapshot>({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "unrelated" }, 9);
    expect(remaining.data?.sessionId).toBe("session-1");
    expect((await usage()).global.postsViewed).toBe(2);
  });

  it("migrates numeric legacy maps as unleased snapshots", async () => {
    const legacy = { ...snapshot }; delete legacy.sessionId;
    mocks.store[STORAGE_KEYS.sessionSnapshots] = { 1: { ownerToken: "old", snapshot: legacy } };
    mocks.tabs = [{ id: 1 }, { id: 2 }];
    const recovered = await send<SessionSnapshot>({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "new" }, 2);
    expect(recovered.data?.stats).toEqual(snapshot.stats);
    expect(recovered.data?.sessionId).toBeDefined();
  });

  it("preserves the legacy source if the destination write fails", async () => {
    mocks.store[STORAGE_KEYS.sessionSnapshot] = snapshot;
    vi.mocked(browserApi.storage.local.set).mockRejectedValueOnce(new Error("write failed"));
    expect((await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "a" }, 1)).ok).toBe(false);
    expect(mocks.store[STORAGE_KEYS.sessionSnapshot]).toEqual(snapshot);
    await restart();
    expect((await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "a" }, 1)).data).toEqual(snapshot);
  });

  it("does not duplicate migration after interruption before source deletion", async () => {
    mocks.store[STORAGE_KEYS.sessionSnapshot] = snapshot;
    vi.mocked(browserApi.storage.local.remove).mockRejectedValueOnce(new Error("interrupted"));
    await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "a" }, 1);
    expect(mocks.store[STORAGE_KEYS.sessionMigration]).toBe(true);
    await restart();
    expect((await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "a" }, 1)).data).toEqual(snapshot);
    expect(Object.keys(mocks.store[STORAGE_KEYS.sessionSnapshots] as object)).toEqual([snapshot.sessionId]);
    expect(mocks.store[STORAGE_KEYS.sessionSnapshot]).toBeUndefined();
  });

  it("keeps Settings clear effective", async () => {
    await open(); await record();
    await send({ type: "focusdeck:clear-session-snapshot" });
    expect((await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "owner-1" }, 1)).data).toBeNull();
  });
  it.each(["navigation", "discard"] as const)("reclaims a disappeared document's allowance without deleting its snapshot (%s)", async (reason) => {
    await open(1); await open(2);
    mocks.store[STORAGE_KEYS.dailyLimits] = { global: { maxPosts: 1 }, perSite: {} };
    const abandoned = view(1);
    await send({ type: "focusdeck:reserve-view", ...abandoned }, 1);
    expect((await send<DailyViewResult>({ type: "focusdeck:reserve-view", ...view(2) }, 2)).data?.allowed).toBe(false);
    mocks.tabUpdated?.(1, reason === "navigation" ? { status: "loading", url: "https://example.com" } : { discarded: true });
    await send({ type: "focusdeck:get-daily-context" });
    await restart();
    expect((await send<DailyViewResult>({ type: "focusdeck:reserve-view", ...view(2) }, 2)).data?.allowed).toBe(true);
    expect((await send({ type: "focusdeck:commit-view", ...abandoned }, 1)).ok).toBe(false);
    expect((await usage()).global.postsViewed).toBe(0);
    const recovered = await send<SessionSnapshot>({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "replacement" }, 1);
    expect(recovered.data?.sessionId).toBe("session-1");
  });

  it("revokes old-token reservations on document replacement but preserves same-document claims", async () => {
    await open(1); await open(2);
    mocks.store[STORAGE_KEYS.dailyLimits] = { global: { maxPosts: 1 }, perSite: {} };
    const abandoned = view(1);
    await send({ type: "focusdeck:reserve-view", ...abandoned }, 1);
    await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "owner-1" }, 1);
    expect((await send<DailyViewResult>({ type: "focusdeck:reserve-view", ...view(2) }, 2)).data?.allowed).toBe(false);
    await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "replacement" }, 1);
    expect((await send<DailyViewResult>({ type: "focusdeck:reserve-view", ...view(2) }, 2)).data?.allowed).toBe(true);
    expect((await send({ type: "focusdeck:commit-view", ...abandoned }, 1)).ok).toBe(false);
  });

  it("does not revoke ownership for same-document URL or video updates", async () => {
    await open(); const request = view();
    await send({ type: "focusdeck:reserve-view", ...request }, 1);
    mocks.tabUpdated?.(1, { url: "https://x.com/alice/status/1", audible: true });
    expect((await send<DailyViewResult>({ type: "focusdeck:commit-view", ...request }, 1)).data?.allowed).toBe(true);
  });

  it("expires abandoned reservations across worker restarts and denies stale commits", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 2, 12));
    await open(1); await open(2);
    mocks.store[STORAGE_KEYS.dailyLimits] = { global: { maxPosts: 1 }, perSite: {} };
    const abandoned = view(1);
    await send({ type: "focusdeck:reserve-view", ...abandoned }, 1);
    await vi.advanceTimersByTimeAsync(20_000);
    // Retransmission cannot keep extending the original bounded reservation.
    await send({ type: "focusdeck:reserve-view", ...abandoned }, 1);
    await restart();
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await send<DailyViewResult>({ type: "focusdeck:reserve-view", ...view(2) }, 2)).data?.allowed).toBe(true);
    expect((await send<DailyViewResult>({ type: "focusdeck:commit-view", ...abandoned }, 1)).data?.allowed).toBe(false);
    expect((await usage()).global.postsViewed).toBe(0);
    expect((await send<SessionSnapshot>({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "replacement" }, 1)).data?.sessionId).toBe("session-1");
    vi.useRealTimers();
  });

  it("recovers an unacknowledged commit at the cap and acknowledges only actual presentation", async () => {
    await open();
    mocks.store[STORAGE_KEYS.dailyLimits] = { global: { maxPosts: 1 }, perSite: {} };
    const request = view();
    await send({ type: "focusdeck:reserve-view", ...request }, 1);
    await send({ type: "focusdeck:commit-view", ...request }, 1);
    mocks.tabs = [{ id: 2 }];
    await restart();
    const recovered = await send<SessionSnapshot>({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "recovered" }, 2);
    expect(recovered.data?.pendingPresentations).toEqual([{ progressKey: "a", postId: "x-status-a" }]);
    const presentation = { ...request, ownerToken: "recovered", requestId: "present" };
    expect((await send<DailyViewResult>({ type: "focusdeck:commit-view", ...presentation }, 2)).data?.allowed).toBe(true);
    expect((await usage()).global.postsViewed).toBe(1);
    expect((await send<SessionSnapshot>({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "recovered" }, 2)).data?.pendingPresentations).toHaveLength(1);
    await send({ type: "focusdeck:ack-view", ...presentation }, 2);
    expect((await send<SessionSnapshot>({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "recovered" }, 2)).data?.pendingPresentations).toBeUndefined();
    expect((await usage()).global.postsViewed).toBe(1);
  });

  it("reclaims provisional ownership after cancelled navigation and reconciles durable progress", async () => {
    await open(); await record();
    mocks.tabUpdated?.(1, { status: "loading", url: "https://example.com" });
    await send({ type: "focusdeck:get-daily-context" });
    expect((mocks.session[STORAGE_KEYS.sessionLeases] as Record<string, { provisional?: boolean }>)[1]?.provisional).toBe(true);
    mocks.tabUpdated?.(1, { status: "complete", url: "https://x.com/home" });
    await restart();
    const reclaimed = await send<SessionSnapshot>({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "owner-1", sessionId: "session-1" }, 1);
    expect(reclaimed.data?.sessionId).toBe("session-1");
    expect(reclaimed.data?.stats.viewedPostIds).toEqual(["a"]);
    expect((await record(1, "b")).data?.allowed).toBe(true);
    expect((await usage()).global.postsViewed).toBe(2);
  });

  it("refuses surviving-document reclaim after another live tab adopts the session", async () => {
    await open(); await record();
    mocks.tabUpdated?.(1, { status: "loading" });
    await send({ type: "focusdeck:get-daily-context" }); await restart();
    const adopted = await send<SessionSnapshot>({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "adopted" }, 2);
    expect(adopted.data?.sessionId).toBe("session-1");
    (mocks.store[STORAGE_KEYS.sessionSnapshots] as Record<string, unknown>)["unrelated"] = {
      snapshot: { ...snapshot, sessionId: "unrelated", updatedAt: Date.now() }, views: {}
    };
    const request = { ...view(1, "b"), ownerToken: "adopted" };
    await send({ type: "focusdeck:reserve-view", ...request }, 2);
    expect((await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "owner-1", sessionId: "session-1" }, 1)).data).toBeNull();
    // More updates from the old tab must not delete the adopter's reservation.
    mocks.tabUpdated?.(1, { status: "loading" });
    expect((await send<DailyViewResult>({ type: "focusdeck:commit-view", ...request }, 2)).data?.allowed).toBe(true);
    expect((await send({ type: "focusdeck:commit-view", ...view() }, 1)).ok).toBe(false);
    expect((await usage()).global.postsViewed).toBe(2);
  });

  it("refuses an old document token after confirmed replacement claims ownership", async () => {
    await open();
    await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "replacement" }, 1);
    expect((await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "owner-1", sessionId: "session-1" }, 1)).data).toBeNull();
    expect((await send({ type: "focusdeck:claim-session", siteId: "x", ownerToken: "replacement", sessionId: "session-1" }, 1)).data).toMatchObject({ sessionId: "session-1" });
  });

  it("distinguishes expired commits from quota denial and permits a fresh reservation", async () => {
    vi.useFakeTimers();
    await open();
    mocks.store[STORAGE_KEYS.dailyLimits] = { global: { maxPosts: 1 }, perSite: {} };
    const stale = view();
    await send({ type: "focusdeck:reserve-view", ...stale }, 1);
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await send<DailyViewResult>({ type: "focusdeck:commit-view", ...stale }, 1)).data).toMatchObject({ allowed: false, denialReason: "expired" });
    expect((await usage()).global.postsViewed).toBe(0);
    const fresh = { ...stale, requestId: "fresh" };
    expect((await send<DailyViewResult>({ type: "focusdeck:reserve-view", ...fresh }, 1)).data?.allowed).toBe(true);
    expect((await send<DailyViewResult>({ type: "focusdeck:commit-view", ...stale }, 1)).data?.allowed).toBe(false);
    expect((await send<DailyViewResult>({ type: "focusdeck:commit-view", ...fresh }, 1)).data?.allowed).toBe(true);
    expect((await usage()).global.postsViewed).toBe(1);
    expect((await send<DailyViewResult>({ type: "focusdeck:reserve-view", ...view(1, "b") }, 1)).data).toMatchObject({ allowed: false, denialReason: "limit" });
    vi.useRealTimers();
  });

});
