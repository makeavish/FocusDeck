import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMessage, RuntimeResponse } from "@/types/messages";

const mocks = vi.hoisted(() => ({ send: vi.fn<(message: RuntimeMessage) => Promise<RuntimeResponse>>() }));
vi.mock("@/shared/browser-polyfill", () => ({ browserApi: { runtime: { sendMessage: mocks.send } } }));

class SettingsElement {
  value = "";
  checked = false;
  disabled = false;
  textContent = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  parentElement: SettingsElement | null = null;
  listeners = new Map<string, () => void>();
  addEventListener(type: string, callback: () => void) { this.listeners.set(type, callback); }
  setAttribute() {}
  removeAttribute() {}
  replaceChildren() {}
  emit(type: string) { this.listeners.get(type)?.(); }
}
let elements: Record<string, SettingsElement>;
let themes: SettingsElement[];
let cache: Map<string, string>;
let finishSave: (response: RuntimeResponse) => void;
async function settle() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }
function chooseTheme(theme: string) {
  for (const input of themes) input.checked = input.value === theme;
  themes.find((input) => input.checked)!.emit("change");
}

beforeEach(async () => {
  vi.resetModules();
  elements = Object.fromEntries(["#sharedDailyLimit", "#hideDistractingElements", "#bypassFollowingFeed", "#usageSummary", "#usageMeter", "#status", ".savebar", "#applyChanges", "#resetDefaults", "#clearSnapshot", "#clearDailyUsage"].map((selector) => [selector, new SettingsElement()]));
  elements["#usageMeter"].parentElement = new SettingsElement();
  themes = ["system", "light", "dark"].map((value) => { const node = new SettingsElement(); node.value = value; return node; });
  cache = new Map();
  vi.stubGlobal("document", {
    querySelector: (selector: string) => elements[selector],
    querySelectorAll: () => themes,
    createElement: () => new SettingsElement(),
    documentElement: new SettingsElement()
  });
  vi.stubGlobal("localStorage", { setItem: (key: string, value: string) => cache.set(key, value) });
  mocks.send.mockReset();
  mocks.send.mockImplementation(async (message) => {
    if (message.type === "focusdeck:get-config") return { ok: true, data: { themeMode: "system" } };
    if (message.type === "focusdeck:get-daily-limits") return { ok: true, data: { global: { maxPosts: 100 }, perSite: {} } };
    if (message.type === "focusdeck:get-site-settings") return { ok: true, data: { enabled: true, hideDistractingElements: false, bypassFollowingFeed: false } };
    if (message.type === "focusdeck:set-config") return new Promise((resolve) => { finishSave = resolve; });
    if (message.type === "focusdeck:set-site-settings" || message.type === "focusdeck:set-daily-limits") return { ok: true, data: message.payload };
    return { ok: true, data: { global: { postsViewed: 0 } } };
  });
  await import("./settings");
  await settle();
});
afterEach(() => vi.unstubAllGlobals());

describe("settings save draft isolation", () => {
  it("saves the clicked draft and retains later edits as unsaved", async () => {
    chooseTheme("light");
    elements["#applyChanges"].emit("click");
    chooseTheme("dark");
    await settle();
    const saved = mocks.send.mock.calls.find(([message]) => message.type === "focusdeck:set-config")?.[0];
    expect(saved).toEqual({ type: "focusdeck:set-config", payload: { themeMode: "light" } });
    finishSave({ ok: true });
    await settle();
    expect(cache.get("focusdeck:settings-theme-mode")).toBe("light");
    expect(themes.find((input) => input.checked)?.value).toBe("dark");
    expect(elements["#applyChanges"].disabled).toBe(false);
    expect(elements["#status"].textContent).toBe("Unsaved changes");
  });

  it("clears dirty state only for an unchanged saved revision", async () => {
    chooseTheme("light");
    elements["#applyChanges"].emit("click");
    elements["#applyChanges"].emit("click");
    await settle();
    expect(mocks.send.mock.calls.filter(([message]) => message.type === "focusdeck:set-config")).toHaveLength(1);
    finishSave({ ok: true });
    await settle();
    expect(elements["#applyChanges"].disabled).toBe(true);
    expect(elements["#status"].textContent).toBe("Changes saved");
  });
});
