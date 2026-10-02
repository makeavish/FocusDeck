import { browserApi } from "@/shared/browser-polyfill";
import { STORAGE_KEYS } from "@/shared/constants";
import { getDailyLimits, getDailyUsage, normalizeSessionSnapshot } from "@/shared/storage";
import { applyUsageDelta, isDailyLimitReached, localDateKey, normalizeUsageForDate } from "@/core/daily-counter";
import type { DailyViewResult, RuntimeMessage } from "@/types/messages";
import type { SessionSnapshot } from "@/types/session";

const RESERVATION_TTL_MS = 30_000;

interface ViewRecord {
  requestId: string;
  postId?: string;
  expiresAt?: number;
  ownerToken: string;
  dateKey: string;
  epoch: string;
  committed: boolean;
  applied: boolean;
  previousFocus: string | null;
}
interface StoredSession {
  snapshot: SessionSnapshot;
  views: Record<string, ViewRecord>;
}
interface Lease {
  provisional?: boolean;
  ownerToken: string;
  sessionId: string | null;
}
type SessionMap = Record<string, StoredSession>;
type LeaseMap = Record<string, Lease>;
type ViewMessage = Extract<RuntimeMessage, { requestId: string }>;

function syncPendingPresentations(entry: StoredSession): void {
  const pending = Object.entries(entry.views).filter(([, view]) => view.committed && !view.applied)
    .map(([progressKey, view]) => ({ progressKey, postId: view.postId ?? null }));
  if (pending.length) entry.snapshot.pendingPresentations = pending;
  else delete entry.snapshot.pendingPresentations;
}

function isReservationLive(view: ViewRecord): boolean {
  const now = Date.now();
  return typeof view.expiresAt === "number" && view.expiresAt > now && view.expiresAt <= now + RESERVATION_TTL_MS;
}

async function readSessions(): Promise<SessionMap> {
  const stored = await browserApi.storage.local.get([STORAGE_KEYS.sessionSnapshots, STORAGE_KEYS.sessionSnapshot, STORAGE_KEYS.sessionMigration]);
  const sessions: SessionMap = {};
  let migrated = false;
  for (const [key, entry] of Object.entries(stored[STORAGE_KEYS.sessionSnapshots] ?? {}) as [string, StoredSession][]) {
    const snapshot = normalizeSessionSnapshot(entry?.snapshot);
    if (!snapshot) continue;
    const sessionId = snapshot.sessionId ?? crypto.randomUUID();
    sessions[sessionId] = { snapshot: { ...snapshot, sessionId }, views: snapshot.sessionId ? entry.views ?? {} : {} };
    migrated ||= key !== sessionId;
  }
  if (!stored[STORAGE_KEYS.sessionMigration]) {
    const legacy = normalizeSessionSnapshot(stored[STORAGE_KEYS.sessionSnapshot]);
    if (legacy) {
      const sessionId = legacy.sessionId ?? crypto.randomUUID();
      sessions[sessionId] ??= { snapshot: { ...legacy, sessionId }, views: {} };
    }
    migrated = true;
  }
  if (migrated) {
    // Commit the destination and marker together before deleting the recoverable source.
    await browserApi.storage.local.set({ [STORAGE_KEYS.sessionSnapshots]: sessions, [STORAGE_KEYS.sessionMigration]: true });
  }
  if (stored[STORAGE_KEYS.sessionSnapshot]) await browserApi.storage.local.remove(STORAGE_KEYS.sessionSnapshot);
  for (const entry of Object.values(sessions)) syncPendingPresentations(entry);
  return sessions;
}

async function readLeases(): Promise<LeaseMap> {
  const stored = (await browserApi.storage.session.get(STORAGE_KEYS.sessionLeases))[STORAGE_KEYS.sessionLeases] ?? {};
  const liveTabs = new Set((await browserApi.tabs.query({})).map((tab) => String(tab.id)));
  return Object.fromEntries(Object.entries(stored).filter(([id]) => liveTabs.has(id))) as LeaseMap;
}

async function ownedSession(tabId: number, ownerToken: string, sessionId?: string) {
  const leases = await readLeases();
  const lease = leases[tabId];
  if (!lease || lease.provisional || lease.ownerToken !== ownerToken || (sessionId && lease.sessionId !== sessionId)) {
    throw new Error("Session ownership changed.");
  }
  const sessions = await readSessions();
  return { leases, lease, sessions, entry: lease.sessionId ? sessions[lease.sessionId] : undefined };
}

export async function claimSession(tabId: number, ownerToken: string, siteId: string, expectedSessionId?: string): Promise<SessionSnapshot | null> {
  const sessions = await readSessions();
  const leases = await readLeases();
  const own = leases[tabId];
  const liveSessions = new Set(Object.entries(leases).filter(([id, lease]) => id !== String(tabId) && !lease.provisional)
    .map(([, lease]) => lease.sessionId));
  let sessionId = own && !own.provisional ? own.sessionId : null;
  if (expectedSessionId) {
    // A surviving document can reclaim only its exact session, never a live owner's session.
    if (liveSessions.has(expectedSessionId) || (own && !own.provisional &&
        (own.ownerToken !== ownerToken || own.sessionId !== expectedSessionId)) ||
        sessions[expectedSessionId]?.snapshot.adapterId !== siteId) return null;
    sessionId = expectedSessionId;
  } else if (!own || own.provisional) {
    sessionId = Object.keys(sessions).filter((id) => !liveSessions.has(id) && sessions[id].snapshot.adapterId === siteId)
      .sort((a, b) => sessions[b].snapshot.updatedAt - sessions[a].snapshot.updatedAt)[0] ?? null;
  }
  const entry = sessionId ? sessions[sessionId] : undefined;
  if (entry) {
    // Uncommitted reservations belong to the old document; committed keys survive recovery.
    for (const [key, view] of Object.entries(entry.views)) {
      if (!view.committed && view.ownerToken !== ownerToken) delete entry.views[key];
      else if (view.committed && !view.applied) view.ownerToken = ownerToken;
    }
    syncPendingPresentations(entry);
    await browserApi.storage.local.set({ [STORAGE_KEYS.sessionSnapshots]: sessions });
  }
  leases[tabId] = { ownerToken, sessionId: entry ? sessionId : null };
  await browserApi.storage.session.set({ [STORAGE_KEYS.sessionLeases]: leases });
  return entry?.snapshot.adapterId === siteId ? entry.snapshot : null;
}

export async function invalidateSessionOwner(tabId: number, provisional = false): Promise<void> {
  const leases = await readLeases();
  const sessionId = leases[tabId]?.sessionId;
  const ownerToken = leases[tabId]?.ownerToken;
  if (provisional && leases[tabId]) leases[tabId].provisional = true;
  else delete leases[tabId];
  // Loading is provisional; a new token or discard confirms replacement. Progress stays recoverable.
  await browserApi.storage.session.set({ [STORAGE_KEYS.sessionLeases]: leases });
  if (!sessionId) return;
  const sessions = await readSessions();
  const entry = sessions[sessionId];
  if (entry) {
    for (const [key, view] of Object.entries(entry.views)) if (!view.committed && view.ownerToken === ownerToken) delete entry.views[key];
    await browserApi.storage.local.set({ [STORAGE_KEYS.sessionSnapshots]: sessions });
  }
}

export async function saveSession(tabId: number, ownerToken: string, snapshot: SessionSnapshot): Promise<SessionSnapshot> {
  const { leases, lease, sessions, entry } = await ownedSession(tabId, ownerToken);
  const normalized = normalizeSessionSnapshot(snapshot);
  if (!normalized) throw new Error("Invalid session.");
  if (lease.sessionId && normalized.sessionId && normalized.sessionId !== lease.sessionId) throw new Error("Session ownership changed.");
  const sessionId = lease.sessionId ?? normalized.sessionId ?? crypto.randomUUID();
  // Presentation saves may be delayed; progress is exclusively committed by view transactions.
  const keys = entry?.snapshot.stats.viewedPostIds ?? normalized.stats.viewedPostIds;
  normalized.sessionId = sessionId;
  normalized.stats.viewedPostIds = [...keys];
  normalized.stats.viewedCount = keys.length;
  sessions[sessionId] = { snapshot: normalized, views: entry?.views ?? {} };
  syncPendingPresentations(sessions[sessionId]);
  await browserApi.storage.local.set({ [STORAGE_KEYS.sessionSnapshots]: sessions });
  lease.sessionId = sessionId;
  await browserApi.storage.session.set({ [STORAGE_KEYS.sessionLeases]: leases });
  return normalized;
}

export async function updateView(tabId: number, message: ViewMessage): Promise<DailyViewResult> {
  const { sessions, entry } = await ownedSession(tabId, message.ownerToken, message.sessionId);
  if (!entry) throw new Error("Session is unavailable.");
  const limits = await getDailyLimits();
  let usage = normalizeUsageForDate(await getDailyUsage(), localDateKey());
  const storedEpoch = (await browserApi.storage.local.get(STORAGE_KEYS.dailyUsageEpoch))[STORAGE_KEYS.dailyUsageEpoch];
  const epoch = typeof storedEpoch === "string" ? storedEpoch : "";
  usage = normalizeUsageForDate(usage, localDateKey());
  for (const stored of Object.values(sessions)) {
    for (const [key, view] of Object.entries(stored.views)) {
      if (!view.committed && !isReservationLive(view)) delete stored.views[key];
    }
  }
  const key = message.progressKey;
  const view = entry.views[key];
  let allowed = true;
  let denialReason: DailyViewResult["denialReason"];
  let changedUsage = false;
  if (message.type === "focusdeck:release-view") {
    if (view?.requestId === message.requestId && view.ownerToken === message.ownerToken && !view.applied) {
      if (view.committed) {
        entry.snapshot.stats.viewedPostIds = entry.snapshot.stats.viewedPostIds.filter((id) => id !== key);
        entry.snapshot.stats.viewedCount = entry.snapshot.stats.viewedPostIds.length;
        if (entry.snapshot.focusedPostId === message.postId) entry.snapshot.focusedPostId = view.previousFocus;
        if (view.dateKey === usage.dateKey && view.epoch === epoch) {
          usage.global.postsViewed = Math.max(0, usage.global.postsViewed - 1);
          const bucket = usage.perSite[entry.snapshot.adapterId];
          if (bucket) bucket.postsViewed = Math.max(0, bucket.postsViewed - 1);
          changedUsage = true;
        }
      }
      delete entry.views[key];
    }
  } else if (message.type === "focusdeck:ack-view") {
    if (view?.committed && view.ownerToken === message.ownerToken) view.applied = true;
  } else if (!entry.snapshot.stats.viewedPostIds.includes(key)) {
    if (message.type === "focusdeck:reserve-view") {
      const leases = await readLeases();
      let reserved = structuredClone(usage);
      for (const lease of Object.values(leases)) {
        if (lease.provisional) continue;
        const pending = lease.sessionId ? sessions[lease.sessionId] : undefined;
        if (!pending) continue;
        for (const reservation of Object.values(pending.views)) {
          if (!reservation.committed && reservation.ownerToken === lease.ownerToken && reservation.dateKey === usage.dateKey && reservation.epoch === epoch) {
            reserved = applyUsageDelta(reserved, pending.snapshot.adapterId, { postsViewed: 1 });
          }
        }
      }
      const sameRequest = view?.requestId === message.requestId && view.ownerToken === message.ownerToken;
      allowed = sameRequest || !isDailyLimitReached(limits, reserved, entry.snapshot.adapterId);
      if (!allowed) denialReason = "limit";
      if (allowed && !sameRequest) entry.views[key] = { requestId: message.requestId, postId: message.postId, expiresAt: Date.now() + RESERVATION_TTL_MS, ownerToken: message.ownerToken, dateKey: usage.dateKey, epoch, committed: false, applied: false, previousFocus: entry.snapshot.focusedPostId };
    } else {
      allowed = view?.requestId === message.requestId && view.ownerToken === message.ownerToken && !isDailyLimitReached(limits, usage, entry.snapshot.adapterId);
      if (!allowed) denialReason = !view ? "expired" : isDailyLimitReached(limits, usage, entry.snapshot.adapterId) ? "limit" : undefined;
      if (allowed) {
        usage = applyUsageDelta(usage, entry.snapshot.adapterId, { postsViewed: 1 });
        changedUsage = true;
        Object.assign(view!, { committed: true, dateKey: usage.dateKey, epoch });
        entry.snapshot.stats.viewedPostIds.push(key);
        entry.snapshot.stats.viewedCount = entry.snapshot.stats.viewedPostIds.length;
        entry.snapshot.focusedPostId = message.postId;
        entry.snapshot.updatedAt = Date.now();
      } else if (view?.requestId === message.requestId) delete entry.views[key];
    }
  }
  syncPendingPresentations(entry);
  await browserApi.storage.local.set({ [STORAGE_KEYS.sessionSnapshots]: sessions, ...(changedUsage ? { [STORAGE_KEYS.dailyUsage]: usage } : {}) });
  return { limits, usage, allowed, ...(denialReason ? { denialReason } : {}), snapshot: entry.snapshot };
}

export async function resetDailyUsage() {
  const usage = normalizeUsageForDate(null, localDateKey());
  await browserApi.storage.local.set({ [STORAGE_KEYS.dailyUsage]: usage, [STORAGE_KEYS.dailyUsageEpoch]: crypto.randomUUID() });
  return usage;
}

export async function clearOwnedSession(tabId: number, ownerToken: string): Promise<void> {
  const leases = await readLeases();
  if (leases[tabId]?.provisional || leases[tabId]?.ownerToken !== ownerToken) return;
  const sessions = await readSessions();
  const sessionId = leases[tabId].sessionId;
  if (sessionId) delete sessions[sessionId];
  await browserApi.storage.local.set({ [STORAGE_KEYS.sessionSnapshots]: sessions });
  leases[tabId].sessionId = null;
  await browserApi.storage.session.set({ [STORAGE_KEYS.sessionLeases]: leases });
}

export async function clearAllSessions(): Promise<void> {
  const leases = await readLeases();
  for (const lease of Object.values(leases)) lease.sessionId = null;
  await browserApi.storage.local.set({ [STORAGE_KEYS.sessionSnapshots]: {}, [STORAGE_KEYS.sessionMigration]: true });
  await browserApi.storage.session.set({ [STORAGE_KEYS.sessionLeases]: leases });
  await browserApi.storage.local.remove(STORAGE_KEYS.sessionSnapshot);
}
