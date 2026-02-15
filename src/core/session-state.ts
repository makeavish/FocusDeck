import type { PauseReason, SessionPhase } from "@/types/session";

export type SessionEvent =
  | { type: "show-prompt" }
  | { type: "start" }
  | { type: "pause"; reason: Exclude<PauseReason, null> }
  | { type: "resume" }
  | { type: "complete" }
  | { type: "stop" };

const ALLOWED: Record<SessionPhase, SessionEvent["type"][]> = {
  idle: ["show-prompt", "start"],
  prompting: ["start", "stop"],
  active: ["pause", "complete", "stop"],
  paused: ["resume", "complete", "stop"],
  completed: ["start", "stop"]
};

export function canTransition(phase: SessionPhase, event: SessionEvent): boolean {
  return ALLOWED[phase].includes(event.type);
}

export function transitionSessionPhase(phase: SessionPhase, event: SessionEvent): SessionPhase {
  if (!canTransition(phase, event)) {
    return phase;
  }

  switch (event.type) {
    case "show-prompt":
      return "prompting";
    case "start":
      return "active";
    case "pause":
      return "paused";
    case "resume":
      return "active";
    case "complete":
      return "completed";
    case "stop":
      return "idle";
    default:
      return phase;
  }
}

