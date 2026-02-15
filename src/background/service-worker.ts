import { DEFAULT_SESSION_CONFIG } from "@/shared/constants";
import { browserApi } from "@/shared/browser-polyfill";
import {
  clearDailyUsage,
  clearSessionSnapshot,
  getDailyLimits,
  getDailyUsage,
  getSessionConfig,
  setDailyLimits,
  updateSessionConfig
} from "@/shared/storage";
import type { RuntimeMessage, RuntimeResponse } from "@/types/messages";

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

browserApi.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") {
    return;
  }

  void updateSessionConfig(DEFAULT_SESSION_CONFIG);
});

browserApi.commands.onCommand.addListener((command) => {
  if (command !== "start-session") {
    return;
  }
  void sendToActiveTab({ type: "focusdeck:start-session" });
});

browserApi.action.onClicked.addListener(() => {
  void openSettingsPage();
});

browserApi.runtime.onMessage.addListener((rawMessage: unknown, sender: { tab?: { id?: number } }): Promise<RuntimeResponse> | RuntimeResponse | void => {
  const message = rawMessage as RuntimeMessage;
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
    return getDailyLimits()
      .then((limits) => ({ ok: true, data: limits }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to read daily limits."
      }));
  }

  if (message.type === "focusdeck:set-daily-limits") {
    return setDailyLimits(message.payload)
      .then((limits) => ({ ok: true, data: limits }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save daily limits."
      }));
  }

  if (message.type === "focusdeck:get-daily-usage") {
    return getDailyUsage()
      .then((usage) => ({ ok: true, data: usage }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to read daily usage."
      }));
  }

  if (message.type === "focusdeck:clear-daily-usage") {
    return clearDailyUsage()
      .then((usage) => ({ ok: true, data: usage }))
      .catch((error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to clear daily usage."
      }));
  }

  if (message.type === "focusdeck:clear-session-snapshot") {
    return clearSessionSnapshot()
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

  if (
    message.type === "focusdeck:start-session" ||
    message.type === "focusdeck:stop-session"
  ) {
    return sendToActiveTab(message);
  }
});
