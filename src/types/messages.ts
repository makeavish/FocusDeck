import type { DailyLimitsConfig, SessionConfig } from "@/types/session";

export type SiteSettings = {
  enabled: boolean;
  suppressPromptDate?: string;
};

export type RuntimeMessage =
  | { type: "focusdeck:start-session"; payload?: Partial<SessionConfig> }
  | { type: "focusdeck:stop-session" }
  | { type: "focusdeck:get-config" }
  | { type: "focusdeck:set-config"; payload: Partial<SessionConfig> }
  | { type: "focusdeck:get-daily-limits" }
  | { type: "focusdeck:set-daily-limits"; payload: DailyLimitsConfig }
  | { type: "focusdeck:get-daily-usage" }
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
