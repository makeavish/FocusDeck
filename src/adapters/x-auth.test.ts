import { describe, expect, it } from "vitest";
import { XAdapter, isXAuthPath, isXFeedPath, resolveXAuthentication } from "@/adapters/x-adapter";

describe("x-adapter auth and feed gating", () => {
  it("detects auth routes", () => {
    expect(isXAuthPath("/i/flow/login")).toBe(true);
    expect(isXAuthPath("/i/flow/signup")).toBe(true);
    expect(isXAuthPath("/home")).toBe(false);
  });

  it("suppresses authentication when logged-out markers are present", () => {
    expect(
      resolveXAuthentication("/home", {
        loggedInShellDetected: false,
        loggedOutMarkersDetected: true,
        feedShellDetected: false
      })
    ).toBe(false);
  });

  it("allows authentication when logged-in shell markers are present", () => {
    expect(
      resolveXAuthentication("/home", {
        loggedInShellDetected: true,
        loggedOutMarkersDetected: true,
        feedShellDetected: false
      })
    ).toBe(true);
  });

  it("allows authentication when feed shell is present even if logged-out markers exist", () => {
    expect(
      resolveXAuthentication("/home", {
        loggedInShellDetected: false,
        loggedOutMarkersDetected: true,
        feedShellDetected: true
      })
    ).toBe(true);
  });

  it("does not treat root path as feed", () => {
    const adapter = new XAdapter();
    expect(isXFeedPath("/")).toBe(false);
    expect(adapter.isFeedPage("https://x.com/")).toBe(false);
  });
});
