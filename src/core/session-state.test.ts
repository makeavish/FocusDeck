import { describe, expect, it } from "vitest";
import { canTransition, transitionSessionPhase } from "@/core/session-state";

describe("session-state transitions", () => {
  it("allows valid transitions", () => {
    expect(canTransition("idle", { type: "show-prompt" })).toBe(true);
    expect(canTransition("prompting", { type: "start" })).toBe(true);
    expect(canTransition("active", { type: "pause", reason: "manual" })).toBe(true);
    expect(canTransition("paused", { type: "resume" })).toBe(true);
    expect(canTransition("active", { type: "complete" })).toBe(true);
  });

  it("blocks invalid transitions", () => {
    expect(canTransition("idle", { type: "resume" })).toBe(false);
    expect(canTransition("completed", { type: "pause", reason: "manual" })).toBe(false);
  });

  it("returns the same phase for invalid transitions", () => {
    expect(transitionSessionPhase("idle", { type: "resume" })).toBe("idle");
    expect(transitionSessionPhase("completed", { type: "pause", reason: "manual" })).toBe("completed");
  });

  it("applies expected phase changes", () => {
    let phase = transitionSessionPhase("idle", { type: "show-prompt" });
    expect(phase).toBe("prompting");

    phase = transitionSessionPhase(phase, { type: "start" });
    expect(phase).toBe("active");

    phase = transitionSessionPhase(phase, { type: "pause", reason: "details" });
    expect(phase).toBe("paused");

    phase = transitionSessionPhase(phase, { type: "resume" });
    expect(phase).toBe("active");

    phase = transitionSessionPhase(phase, { type: "complete" });
    expect(phase).toBe("completed");
  });
});

