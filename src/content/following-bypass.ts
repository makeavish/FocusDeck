import type { SiteSettings } from "@/types/messages";
import type { PauseReason, SessionPhase } from "@/types/session";

export type SelectedHomeTimeline = "forYou" | "following" | null;

function normalizeTabText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function detectSelectedHomeTimeline(root: ParentNode = document): SelectedHomeTimeline {
  const selectedTabs = Array.from(root.querySelectorAll<HTMLElement>("[role='tab'][aria-selected='true']"));
  const matches = new Set<Exclude<SelectedHomeTimeline, null>>();

  for (const tab of selectedTabs) {
    const label = normalizeTabText([tab.textContent ?? "", tab.getAttribute("aria-label") ?? ""].join(" "));

    if (!label) {
      continue;
    }

    if (label.includes("for you")) {
      matches.add("forYou");
    }

    if (label.includes("following")) {
      matches.add("following");
    }
  }

  if (matches.size !== 1) {
    return null;
  }

  return Array.from(matches)[0] ?? null;
}

export function isFollowingBypassActive(
  settings: SiteSettings | null | undefined,
  isFeedRouteActive: boolean,
  root: ParentNode = document
): boolean {
  return Boolean(settings?.bypassFollowingFeed) && isFeedRouteActive && detectSelectedHomeTimeline(root) === "following";
}

export function shouldPauseFollowingBypass(phase: SessionPhase): boolean {
  return phase === "active";
}

export function shouldResumeFromFollowingBypass(phase: SessionPhase, pauseReason: PauseReason): boolean {
  return phase === "paused" && pauseReason === "followingBypass";
}

export function shouldSuppressFollowingLimitUi(bypassActive: boolean): boolean {
  return bypassActive;
}
