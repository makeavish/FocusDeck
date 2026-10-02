import type { DailyLimitsConfig, DailyUsage, SessionConfig, SessionSnapshot } from "@/types/session";

export type SiteSettings = {
  enabled: boolean;
  suppressPromptDate?: string;
  hideDistractingElements: boolean;
  bypassFollowingFeed: boolean;
};

export interface DailyContext {
  limits: DailyLimitsConfig;
  usage: DailyUsage;
}

export interface DailyViewResult extends DailyContext {
  allowed: boolean;
  denialReason?: "expired" | "limit";
  snapshot?: SessionSnapshot;
}

export type RuntimeMessage =
  | { type: "focusdeck:start-session"; payload?: Partial<SessionConfig> }
  | { type: "focusdeck:stop-session" }
  | { type: "focusdeck:get-config" }
  | { type: "focusdeck:set-config"; payload: Partial<SessionConfig> }
  | { type: "focusdeck:get-daily-limits" }
  | { type: "focusdeck:set-daily-limits"; payload: DailyLimitsConfig }
  | { type: "focusdeck:get-daily-usage" }
  | { type: "focusdeck:get-daily-context" }
  | { type: "focusdeck:reserve-view" | "focusdeck:commit-view" | "focusdeck:release-view" | "focusdeck:ack-view"; ownerToken: string; sessionId: string; requestId: string; progressKey: string; postId: string }
  | { type: "focusdeck:claim-session"; ownerToken: string; siteId: string; sessionId?: string }
  | { type: "focusdeck:save-session"; ownerToken: string; snapshot: SessionSnapshot }
  | { type: "focusdeck:clear-owned-session"; ownerToken: string }
  | { type: "focusdeck:get-site-settings"; siteId: string }
  | { type: "focusdeck:set-site-settings"; siteId: string; payload: Partial<SiteSettings> }
  | { type: "focusdeck:clear-session-snapshot" }
  | { type: "focusdeck:clear-daily-usage" }
  | { type: "focusdeck:open-settings" }
  | { type: "focusdeck:close-tab" }
  | { type: "focusdeck:open-background-tab"; url: string };

export type RuntimeResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};
