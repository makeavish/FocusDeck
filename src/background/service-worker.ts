import { claimSession, clearAllSessions, clearOwnedSession, saveSession, updateView, resetDailyUsage, invalidateSessionOwner } from "./session-store";
import { DEFAULT_SESSION_CONFIG } from "@/shared/constants";
import { browserApi } from "@/shared/browser-polyfill";
import {
  getDailyLimits,
  getDailyUsage,
  getSessionConfig,
  getSiteSettings,
  setDailyLimits,
  updateSiteSettings,
  updateSessionConfig
} from "@/shared/storage";
import type { RuntimeMessage, RuntimeResponse } from "@/types/messages";

let storageQueue: Promise<unknown> = Promise.resolve();

function serializeStorage<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(operation, operation);
  storageQueue = result.catch(() => undefined);
  return result;
}

async function readDailyContext() {
  return { limits: await getDailyLimits(), usage: await getDailyUsage() };
}

async function openSettingsPage(): Promise<void> {
  try {
    await browserApi.runtime.openOptionsPage();
    return;
  } catch {
    const settingsUrl = browserApi.runtime.getURL("settings/settings.html");
    const tabs = await browserApi.tabs.query({});
    const existing = tabs.find((tab) => tab.url?.startsWith(settingsUrl));
    if (existing?.id) {
      await browserApi.tabs.update(existing.id, { active: true });
      return;
    }

    await browserApi.tabs.create({ url: settingsUrl });
  }
}

async function sendToActiveTab(message: RuntimeMessage): Promise<RuntimeResponse> {
  const tabs = await browserApi.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (!activeTab?.id) {
    return { ok: false, error: "No active tab found." };
  }

  try {
    const response = (await browserApi.tabs.sendMessage(activeTab.id, message)) as RuntimeResponse | undefined;
    return response ?? { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to message active tab."
    };
  }
}

async function closeSenderTab(senderTabId?: number): Promise<void> {
  if (senderTabId) {
    await browserApi.tabs.remove(senderTabId);
    return;
  }

  const tabs = await browserApi.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (!activeTab?.id) {
    throw new Error("No active tab found.");
  }

  await browserApi.tabs.remove(activeTab.id);
}

async function openBackgroundTab(url: string, senderWindowId?: number): Promise<void> {
  const createOptions: {
    url: string;
    active: boolean;
    windowId?: number;
  } = {
    url,
    active: false
  };

  if (typeof senderWindowId === "number") {
    createOptions.windowId = senderWindowId;
  }

  await browserApi.tabs.create(createOptions);
}

browserApi.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") {
    return;
  }

  void updateSessionConfig(DEFAULT_SESSION_CONFIG);
});

browserApi.action.onClicked.addListener(() => {
  void openSettingsPage();
});

browserApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.discarded === true) {
    void serializeStorage(() => invalidateSessionOwner(tabId, changeInfo.discarded !== true)).catch(() => undefined);
  }
});

browserApi.runtime.onMessage.addListener((rawMessage: unknown, sender: { tab?: { id?: number; windowId?: number } }): Promise<RuntimeResponse> | RuntimeResponse | void => {
  const message = rawMessage as RuntimeMessage;
  if (message.type === "focusdeck:get-daily-context") {
    return serializeStorage(readDailyContext)
      .then((data) => ({ ok: true, data }))
      .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : "Failed to read usage." }));
  }

  if (message.type === "focusdeck:reserve-view" || message.type === "focusdeck:commit-view" ||
      message.type === "focusdeck:release-view" || message.type === "focusdeck:ack-view") {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") return { ok: false, error: "View requests require a feed tab." };
    return serializeStorage(() => updateView(tabId, message))
      .then((data) => ({ ok: true, data }))
      .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : "Failed to record usage." }));
  }

  if (message.type === "focusdeck:claim-session" || message.type === "focusdeck:save-session" || message.type === "focusdeck:clear-owned-session") {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") {
      return { ok: false, error: "Session requests require a feed tab." };
    }
    return serializeStorage(async () => {
      if (message.type === "focusdeck:claim-session") {
        return { ok: true, data: await claimSession(tabId, message.ownerToken, message.siteId, message.sessionId) };
      }
      if (message.type === "focusdeck:save-session") {
        return { ok: true, data: await saveSession(tabId, message.ownerToken, message.snapshot) };
      } else {
        await clearOwnedSession(tabId, message.ownerToken);
      }
      return { ok: true };
    }).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : "Failed to save session." }));
  }

  if (message.type === "focusdeck:get-config") {
    return getSessionConfig()
      .then((config) => ({ ok: true, data: config }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to load config."
      }));
  }

  if (message.type === "focusdeck:set-config") {
    return updateSessionConfig(message.payload)
      .then((config) => ({ ok: true, data: config }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to update config."
      }));
  }

  if (message.type === "focusdeck:get-daily-limits") {
    return serializeStorage(getDailyLimits)
      .then((limits) => ({ ok: true, data: limits }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to read daily limits."
      }));
  }

  if (message.type === "focusdeck:set-daily-limits") {
    return serializeStorage(() => setDailyLimits(message.payload))
      .then((limits) => ({ ok: true, data: limits }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save daily limits."
      }));
  }

  if (message.type === "focusdeck:get-daily-usage") {
    return serializeStorage(getDailyUsage)
      .then((usage) => ({ ok: true, data: usage }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to read daily usage."
      }));
  }

  if (message.type === "focusdeck:get-site-settings") {
    return getSiteSettings(message.siteId)
      .then((settings) => ({ ok: true, data: settings }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to read site settings."
      }));
  }

  if (message.type === "focusdeck:set-site-settings") {
    return updateSiteSettings(message.siteId, message.payload)
      .then((settings) => ({ ok: true, data: settings }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save site settings."
      }));
  }

  if (message.type === "focusdeck:clear-daily-usage") {
    return serializeStorage(resetDailyUsage)
      .then((usage) => ({ ok: true, data: usage }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to clear daily usage."
      }));
  }

  if (message.type === "focusdeck:clear-session-snapshot") {
    return serializeStorage(clearAllSessions)
      .then(() => ({ ok: true }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to clear session snapshot."
      }));
  }

  if (message.type === "focusdeck:open-settings") {
    return openSettingsPage()
      .then(() => ({ ok: true }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to open settings."
      }));
  }

  if (message.type === "focusdeck:close-tab") {
    return closeSenderTab(sender.tab?.id)
      .then(() => ({ ok: true }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to close tab."
      }));
  }

  if (message.type === "focusdeck:open-background-tab") {
    return openBackgroundTab(message.url, sender.tab?.windowId)
      .then(() => ({ ok: true }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to open background tab."
      }));
  }

  if (
    message.type === "focusdeck:start-session" ||
    message.type === "focusdeck:stop-session"
  ) {
    return sendToActiveTab(message);
  }
});
