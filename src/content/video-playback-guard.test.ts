import { describe, expect, it } from "vitest";
import { resolveVideoPlaybackGuardDecision } from "@/content/video-playback-guard";

describe("resolveVideoPlaybackGuardDecision", () => {
  it("uses immediate sync for pointer interactions on a focused video", () => {
    for (const eventType of ["pointerdown", "click"] as const) {
      const decision = resolveVideoPlaybackGuardDecision({
        eventType,
        matchedFocusedVideo: true,
        mediaEnded: false
      });

      expect(decision.syncMode).toBe("now");
      expect(decision.freeze).toEqual({ mode: "set", durationMs: 8_000 });
      expect(decision.bypass).toEqual({ mode: "set", durationMs: 8_000 });
    }
  });

  it("uses deferred sync for play and waiting events", () => {
    const cases = [
      { eventType: "play" as const, durationMs: 180_000 },
      { eventType: "playing" as const, durationMs: 180_000 },
      { eventType: "waiting" as const, durationMs: 90_000 }
    ];

    for (const testCase of cases) {
      const decision = resolveVideoPlaybackGuardDecision({
        eventType: testCase.eventType,
        matchedFocusedVideo: true,
        mediaEnded: false
      });

      expect(decision.syncMode).toBe("soon");
      expect(decision.freeze).toEqual({ mode: "set", durationMs: testCase.durationMs });
      expect(decision.bypass).toEqual({ mode: "set", durationMs: testCase.durationMs });
    }
  });

  it("clears freeze and bypass on pause when media already ended", () => {
    const decision = resolveVideoPlaybackGuardDecision({
      eventType: "pause",
      matchedFocusedVideo: true,
      mediaEnded: true
    });

    expect(decision.syncMode).toBe("soon");
    expect(decision.freeze).toEqual({ mode: "clear" });
    expect(decision.bypass).toEqual({ mode: "clear" });
  });

  it("returns no-op for non-matching targets", () => {
    for (const eventType of ["pointerdown", "play", "pause", "ended"] as const) {
      const decision = resolveVideoPlaybackGuardDecision({
        eventType,
        matchedFocusedVideo: false,
        mediaEnded: true
      });

      expect(decision.syncMode).toBe("none");
      expect(decision.freeze).toEqual({ mode: "none" });
      expect(decision.bypass).toEqual({ mode: "none" });
    }
  });
});
