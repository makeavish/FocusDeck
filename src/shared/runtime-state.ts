import { browserApi } from "@/shared/browser-polyfill";
import type { DailyContext, DailyViewResult, RuntimeMessage, RuntimeResponse } from "@/types/messages";
import type { SessionSnapshot } from "@/types/session";

const ownerToken = crypto.randomUUID();

async function request<T>(message: RuntimeMessage): Promise<T> {
  const response = await browserApi.runtime.sendMessage(message) as RuntimeResponse<T> | undefined;
  if (!response?.ok) {
    throw new Error(response?.error ?? "FocusDeck background is unavailable.");
  }
  return response.data as T;
}

export function getDailyContext(): Promise<DailyContext> {
  return request({ type: "focusdeck:get-daily-context" });
}

export interface ViewRequest {
  sessionId: string;
  requestId: string;
  progressKey: string;
  postId: string;
}

export function reserveDailyView(view: ViewRequest): Promise<DailyViewResult> {
  return request({ type: "focusdeck:reserve-view", ownerToken, ...view });
}

export function commitDailyView(view: ViewRequest): Promise<DailyViewResult> {
  return request({ type: "focusdeck:commit-view", ownerToken, ...view });
}

export function releaseDailyView(view: ViewRequest): Promise<DailyViewResult> {
  return request({ type: "focusdeck:release-view", ownerToken, ...view });
}

export function acknowledgeDailyView(view: ViewRequest): Promise<void> {
  return request({ type: "focusdeck:ack-view", ownerToken, ...view });
}

export function claimSessionSnapshot(siteId: string, sessionId?: string): Promise<SessionSnapshot | null> {
  return request({ type: "focusdeck:claim-session", ownerToken, siteId, sessionId });
}

export function saveOwnedSessionSnapshot(snapshot: SessionSnapshot): Promise<SessionSnapshot> {
  return request({ type: "focusdeck:save-session", ownerToken, snapshot });
}

export function clearOwnedSessionSnapshot(): Promise<void> {
  return request({ type: "focusdeck:clear-owned-session", ownerToken });
}
