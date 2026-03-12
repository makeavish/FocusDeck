import { describe, expect, it } from "vitest";
import {
  detectSelectedHomeTimeline,
  isFollowingBypassActive,
  shouldPauseFollowingBypass,
  shouldResumeFromFollowingBypass,
  shouldSuppressFollowingLimitUi
} from "@/content/following-bypass";
import type { SiteSettings } from "@/types/messages";

type FakeTab = {
  textContent: string;
  getAttribute(name: string): string | null;
};

function buildRoot(selectedLabels: string[]): ParentNode {
  const tabs: FakeTab[] = [
    {
      textContent: "For you",
      getAttribute: (name: string) => (name === "aria-label" ? "For you" : null)
    },
    {
      textContent: "Following",
      getAttribute: (name: string) => (name === "aria-label" ? "Following" : null)
    }
  ].map((tab) => ({
    ...tab,
    getAttribute: (name: string) => {
      if (name === "aria-label") {
        return tab.textContent;
      }
      if (name === "aria-selected") {
        return selectedLabels.includes(tab.textContent) ? "true" : "false";
      }
      return null;
    }
  }));

  return {
    querySelectorAll: () => tabs.filter((tab) => tab.getAttribute("aria-selected") === "true")
  } as unknown as ParentNode;
}

const ENABLED_SETTINGS: SiteSettings = {
  enabled: true,
  suppressPromptDate: "",
  hideDistractingElements: false,
  bypassFollowingFeed: true
};

describe("Following bypass helpers", () => {
  it("detects the selected Following tab", () => {
    const root = buildRoot(["Following"]);

    expect(detectSelectedHomeTimeline(root)).toBe("following");
    expect(isFollowingBypassActive(ENABLED_SETTINGS, true, root)).toBe(true);
  });

  it("does not activate when For you is selected", () => {
    const root = buildRoot(["For you"]);

    expect(detectSelectedHomeTimeline(root)).toBe("forYou");
    expect(isFollowingBypassActive(ENABLED_SETTINGS, true, root)).toBe(false);
  });

  it("fails safe when the selected tab is ambiguous", () => {
    const root = buildRoot(["For you", "Following"]);

    expect(detectSelectedHomeTimeline(root)).toBeNull();
    expect(isFollowingBypassActive(ENABLED_SETTINGS, true, root)).toBe(false);
  });

  it("pauses active sessions and resumes paused bypass sessions", () => {
    expect(shouldPauseFollowingBypass("active")).toBe(true);
    expect(shouldPauseFollowingBypass("paused")).toBe(false);
    expect(shouldResumeFromFollowingBypass("paused", "followingBypass")).toBe(true);
    expect(shouldResumeFromFollowingBypass("paused", "details")).toBe(false);
  });

  it("suppresses daily-limit UI while the bypass is active", () => {
    expect(shouldSuppressFollowingLimitUi(true)).toBe(true);
    expect(shouldSuppressFollowingLimitUi(false)).toBe(false);
  });
});
