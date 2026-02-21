import type { DailyLimitsConfig, SessionConfig } from "@/types/session";

export const STORAGE_KEYS = {
  sessionConfig: "focusdeck:session-config",
  sessionSnapshot: "focusdeck:session-snapshot",
  siteSettings: "focusdeck:site-settings",
  dailyLimits: "focusdeck:daily-limits",
  dailyUsage: "focusdeck:daily-usage"
} as const;

export const ACTION_RATE_LIMIT_MS = 1000;

export const OVERLAY_HOST_ID = "focusdeck-overlay-host";
export const OVERLAY_Z_INDEX = 2_147_483_000;

export const KEY_BINDINGS = {
  next: ["j", "J", "ArrowDown"],
  previous: ["k", "K", "ArrowUp"],
  bookmark: ["s", "S"],
  notInterested: ["x", "X"],
  openPost: ["o", "O"],
  toggleOverlay: ["Escape"]
} as const;

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  mode: "posts",
  themeMode: "system",
  postLimit: 20,
  timeLimitMinutes: 10,
  minimalMode: true
};

export const DEFAULT_SITE_SETTINGS = {
  enabled: true,
  suppressPromptDate: ""
};

export const DEFAULT_DAILY_LIMITS: DailyLimitsConfig = {
  global: {
    maxPosts: 0,
    maxMinutes: 0
  },
  perSite: {}
};
