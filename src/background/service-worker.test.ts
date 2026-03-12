import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state: {
    messageListener: ((message: unknown, sender: { tab?: { id?: number; windowId?: number } }) => Promise<unknown> | unknown) | null;
  } = {
    messageListener: null
  };

  return {
    state,
    openOptionsPage: vi.fn(async () => undefined),
    getURL: vi.fn((path: string) => `chrome-extension://focusdeck/${path}`),
    onInstalledAddListener: vi.fn(),
    onMessageAddListener: vi.fn((listener: typeof state.messageListener) => {
      state.messageListener = listener;
    }),
    actionOnClickedAddListener: vi.fn(),
    tabsQuery: vi.fn(async () => []),
    tabsUpdate: vi.fn(async () => undefined),
    tabsCreate: vi.fn(async () => undefined),
    tabsSendMessage: vi.fn(async () => ({ ok: true })),
    tabsRemove: vi.fn(async () => undefined),
    getSessionConfig: vi.fn(async () => ({ themeMode: "system", postLimit: 20, minimalMode: true })),
    updateSessionConfig: vi.fn(async (payload?: unknown) => ({ themeMode: "system", postLimit: 20, minimalMode: true, ...(payload as object) })),
    getDailyLimits: vi.fn(async () => ({ global: { maxPosts: 100 }, perSite: {} })),
    setDailyLimits: vi.fn(async (payload: unknown) => payload),
    getDailyUsage: vi.fn(async () => ({ dateKey: "2026-03-12", global: { postsViewed: 0 }, perSite: {} })),
    clearDailyUsage: vi.fn(async () => ({ dateKey: "2026-03-12", global: { postsViewed: 0 }, perSite: {} })),
    clearSessionSnapshot: vi.fn(async () => undefined),
    getSiteSettings: vi.fn(async () => ({
      enabled: true,
      suppressPromptDate: "",
      hideDistractingElements: false
    })),
    updateSiteSettings: vi.fn(async (_siteId: string, payload: Record<string, unknown>) => ({
      enabled: true,
      suppressPromptDate: "",
      hideDistractingElements: Boolean(payload.hideDistractingElements)
    }))
  };
});

vi.mock("@/shared/browser-polyfill", () => ({
  browserApi: {
    runtime: {
      openOptionsPage: mocks.openOptionsPage,
      getURL: mocks.getURL,
      onInstalled: {
        addListener: mocks.onInstalledAddListener
      },
      onMessage: {
        addListener: mocks.onMessageAddListener
      }
    },
    action: {
      onClicked: {
        addListener: mocks.actionOnClickedAddListener
      }
    },
    tabs: {
      query: mocks.tabsQuery,
      update: mocks.tabsUpdate,
      create: mocks.tabsCreate,
      sendMessage: mocks.tabsSendMessage,
      remove: mocks.tabsRemove
    }
  }
}));

vi.mock("@/shared/storage", () => ({
  getSessionConfig: mocks.getSessionConfig,
  updateSessionConfig: mocks.updateSessionConfig,
  getDailyLimits: mocks.getDailyLimits,
  setDailyLimits: mocks.setDailyLimits,
  getDailyUsage: mocks.getDailyUsage,
  clearDailyUsage: mocks.clearDailyUsage,
  clearSessionSnapshot: mocks.clearSessionSnapshot,
  getSiteSettings: mocks.getSiteSettings,
  updateSiteSettings: mocks.updateSiteSettings
}));

await import("@/background/service-worker");

describe("background service worker site settings messaging", () => {
  beforeEach(() => {
    mocks.getSiteSettings.mockClear();
    mocks.updateSiteSettings.mockClear();
  });

  it("returns stored site settings", async () => {
    const listener = mocks.state.messageListener;
    expect(listener).toBeTypeOf("function");

    const response = await listener?.({ type: "focusdeck:get-site-settings", siteId: "x" }, {});

    expect(mocks.getSiteSettings).toHaveBeenCalledWith("x");
    expect(response).toEqual({
      ok: true,
      data: {
        enabled: true,
        suppressPromptDate: "",
        hideDistractingElements: false
      }
    });
  });

  it("persists updated site settings", async () => {
    const listener = mocks.state.messageListener;
    expect(listener).toBeTypeOf("function");

    const response = await listener?.(
      {
        type: "focusdeck:set-site-settings",
        siteId: "x",
        payload: { hideDistractingElements: true }
      },
      {}
    );

    expect(mocks.updateSiteSettings).toHaveBeenCalledWith("x", { hideDistractingElements: true });
    expect(response).toEqual({
      ok: true,
      data: {
        enabled: true,
        suppressPromptDate: "",
        hideDistractingElements: true
      }
    });
  });
});
