export type VideoPlaybackGuardEvent =
  | "pointerdown"
  | "click"
  | "play"
  | "playing"
  | "waiting"
  | "pause"
  | "ended";

export type VideoPlaybackGuardMutation =
  | { mode: "none" }
  | { mode: "set"; durationMs: number }
  | { mode: "clear" };

export type VideoPlaybackGuardSyncMode = "none" | "now" | "soon";

export type VideoPlaybackGuardDecisionInput = {
  eventType: VideoPlaybackGuardEvent;
  matchedFocusedVideo: boolean;
  mediaEnded: boolean;
};

export type VideoPlaybackGuardDecision = {
  freeze: VideoPlaybackGuardMutation;
  bypass: VideoPlaybackGuardMutation;
  syncMode: VideoPlaybackGuardSyncMode;
};

const NOOP_MUTATION: VideoPlaybackGuardMutation = { mode: "none" };
const CLEAR_MUTATION: VideoPlaybackGuardMutation = { mode: "clear" };

function setMutation(durationMs: number): VideoPlaybackGuardMutation {
  return { mode: "set", durationMs };
}

function setDecision(durationMs: number, syncMode: Exclude<VideoPlaybackGuardSyncMode, "none">): VideoPlaybackGuardDecision {
  return {
    freeze: setMutation(durationMs),
    bypass: setMutation(durationMs),
    syncMode
  };
}

function clearDecision(syncMode: Exclude<VideoPlaybackGuardSyncMode, "none">): VideoPlaybackGuardDecision {
  return {
    freeze: CLEAR_MUTATION,
    bypass: CLEAR_MUTATION,
    syncMode
  };
}

export function resolveVideoPlaybackGuardDecision(input: VideoPlaybackGuardDecisionInput): VideoPlaybackGuardDecision {
  if (!input.matchedFocusedVideo) {
    return {
      freeze: NOOP_MUTATION,
      bypass: NOOP_MUTATION,
      syncMode: "none"
    };
  }

  if (input.eventType === "pointerdown" || input.eventType === "click") {
    return setDecision(8_000, "now");
  }

  if (input.eventType === "play" || input.eventType === "playing") {
    return setDecision(180_000, "soon");
  }

  if (input.eventType === "waiting") {
    return setDecision(90_000, "soon");
  }

  if (input.eventType === "pause") {
    if (input.mediaEnded) {
      return clearDecision("soon");
    }

    return setDecision(20_000, "soon");
  }

  if (input.eventType === "ended") {
    return clearDecision("soon");
  }

  return {
    freeze: NOOP_MUTATION,
    bypass: NOOP_MUTATION,
    syncMode: "none"
  };
}
