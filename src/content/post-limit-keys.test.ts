import { describe, expect, it } from "vitest";
import { expandPostLimitViewedKeys, isHandleViewedInPostLimit } from "@/content/post-limit-keys";

describe("post-limit key matching", () => {
  it("treats either handle id or progress key as viewed", () => {
    const viewed = new Set(["x-status-1"]);
    expect(isHandleViewedInPostLimit(viewed, "x-status-1", "123")).toBe(true);
    expect(isHandleViewedInPostLimit(viewed, "x-status-2", "x-status-1")).toBe(true);
    expect(isHandleViewedInPostLimit(viewed, "x-status-2", "123")).toBe(false);
  });

  it("expands viewed keys to include aliases for current handles", () => {
    const expanded = expandPostLimitViewedKeys(
      new Set(["x-status-1", "12345"]),
      [
        { handleId: "x-status-1", progressKey: "12345" },
        { handleId: "x-status-2", progressKey: "99999" }
      ]
    );

    expect(expanded.has("x-status-1")).toBe(true);
    expect(expanded.has("12345")).toBe(true);
    expect(expanded.has("x-status-2")).toBe(false);
    expect(expanded.has("99999")).toBe(false);
  });
});
