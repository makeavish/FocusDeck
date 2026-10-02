import { describe, expect, it } from "vitest";
import { normalizeXStatusPermalink, resolveBestXPermalink } from "@/adapters/x-adapter";

describe("x-adapter permalink resolution", () => {
  it("normalizes photo and video detail URLs back to the post permalink", () => {
    expect(normalizeXStatusPermalink("https://x.com/djfarrelly/status/1899930306353080500/photo/1")).toBe(
      "https://x.com/djfarrelly/status/1899930306353080500"
    );
    expect(normalizeXStatusPermalink("https://twitter.com/djfarrelly/status/1899930306353080500/video/1")).toBe(
      "https://twitter.com/djfarrelly/status/1899930306353080500"
    );
  });

  it("prefers the status permalink over other internal X links", () => {
    const permalink = resolveBestXPermalink([
      {
        url: "https://x.com/djfarrelly"
      },
      {
        url: "https://x.com/djfarrelly/status/1899930306353080500",
        hasTime: true,
        inUserNameBlock: true
      },
      {
        url: "https://x.com/i/articles/1234567890"
      }
    ]);

    expect(permalink).toBe("https://x.com/djfarrelly/status/1899930306353080500");
  });

  it("accepts i/status links when that is the only tweet permalink candidate", () => {
    const permalink = resolveBestXPermalink([
      {
        url: "https://x.com/explore"
      },
      {
        url: "https://x.com/i/status/1899930306353080500",
        hasTime: true
      }
    ]);

    expect(permalink).toBe("https://x.com/i/status/1899930306353080500");
  });
});

import { afterEach, vi } from "vitest";
import { XAdapter } from "@/adapters/x-adapter";
import { hasXFeedMutation, isXAdUnit } from "@/adapters/x-dom";

class CardFixture {
  tag = "article";
  links: LinkFixture[] = [];
  buttons: ButtonFixture[] = [];
  markers: LinkFixture[] = [];
  attrs = new Map<string, string>();
  parentElement: CardFixture | null = null;
  secondary = false;
  fallback = false;
  isConnected = true;
  textContent = "Post body";
  dataset: Record<string, string> = {};
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  matches(selector: string) {
    return this.tag === "article" && selector.split(",").some((part) => part.includes("article") &&
      (part.includes("data-testid") ? !this.fallback : part.includes("role") ? this.fallback : true));
  }
  closest(selector: string): CardFixture | null {
    if (selector.includes("quoteTweet") && this.secondary) return this;
    if (selector.includes("primaryColumn") || selector === "main") return this;
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  contains(node: unknown) { return this.links.includes(node as LinkFixture) || this.buttons.includes(node as ButtonFixture); }
  querySelector(selector: string): unknown {
    if (selector.startsWith("button")) return this.buttons[0] ?? null;
    if (selector.includes("a[") && this.links.length) return this.links[0];
    if (selector.includes("tweetText")) return { textContent: this.textContent };
    return null;
  }
  querySelectorAll(selector: string): unknown[] {
    if (selector.startsWith("a[")) return this.links;
    if (selector === "button") return this.buttons;
    if (selector.includes("promotedIndicator")) return this.markers;
    return [];
  }
}
class LinkFixture extends CardFixture {
  tag = "a";
  body = false;
  constructor(readonly owner: CardFixture, readonly href: string, readonly time = false, secondary = false) {
    super();
    this.secondary = secondary;
    this.textContent = "";
  }
  closest(selector: string): CardFixture | null {
    if (selector.includes("quoteTweet") && this.secondary) return this;
    if (selector.includes("tweetText") && this.body) return this;
    if (selector.includes("article")) return this.owner;
    return null;
  }
  querySelector(selector: string): unknown { return selector === "time" && this.time ? {} : null; }
}
class ButtonFixture extends LinkFixture {
  tag = "button";
  click = vi.fn();
}
function card(status: string, fallback = false): CardFixture {
  const root = new CardFixture();
  root.fallback = fallback;
  root.links = [new LinkFixture(root, `https://x.com/alice/status/${status}`)];
  return root;
}
function setupCards(cards: CardFixture[]): void {
  vi.stubGlobal("document", { querySelectorAll: (selector: string) => cards.filter((item) => item.matches(selector)) });
  vi.stubGlobal("Element", CardFixture);
}
function asHandle(element: CardFixture) {
  return { id: "fixture", element: element as unknown as HTMLElement };
}

afterEach(() => vi.unstubAllGlobals());

describe("X card enumeration, progress and action safety", () => {
  it("enumerates duplicate IDs and mixed primary/fallback cards while excluding quotes", () => {
    const a = card("1");
    const duplicate = card("1", true);
    const nested = card("2", true);
    nested.parentElement = a;
    const quoted = card("3");
    quoted.secondary = true;
    setupCards([a, duplicate, nested, quoted]);
    const adapter = new XAdapter();
    const handles = adapter.getFeedItems();
    expect(handles.map((handle) => handle.element)).toEqual([a, duplicate]);
    expect(handles.map((handle) => adapter.getProgressKey(handle))).toEqual(["1", "1"]);
  });

  it("selects primary and fallback cards independently of duplicate IDs", () => {
    const primary = card("11");
    const fallback = card("22", true);
    setupCards([primary, fallback]);
    expect(document.querySelectorAll("article[data-testid='tweet']")).toEqual([primary]);
    expect(document.querySelectorAll("article[role='article']")).toEqual([fallback]);
    expect(new XAdapter().getFeedItems().map((item) => item.element)).toEqual([primary, fallback]);
  });

  it("retains separate DOM cards with the same canonical ID", () => {
    const first = card("11");
    const second = card("11");
    setupCards([first, second]);
    const adapter = new XAdapter();
    const handles = adapter.getFeedItems();
    expect(handles.map((item) => item.element)).toEqual([first, second]);
    expect(handles.map((item) => adapter.getProgressKey(item))).toEqual(["11", "11"]);
  });

  it.each(["pause", "navigation", "recycle", "detach", "valid"] as const)("revalidates delayed Hide immediately before its menu click (%s)", async (change) => {
    vi.useFakeTimers();
    try {
      const root = card("1");
      const caret = new ButtonFixture(root, "");
      root.buttons = [caret];
      const menu = new ButtonFixture(root, "");
      menu.textContent = "Not interested";
      let ready = false;
      let current = true;
      vi.stubGlobal("document", { querySelectorAll: (selector: string) => selector.includes("menuitem") && ready ? [menu] : [] });
      vi.stubGlobal("window", { setTimeout });
      const action = new XAdapter().notInterested(asHandle(root), () => current);
      expect(caret.click).toHaveBeenCalledTimes(1);
      if (change === "pause" || change === "navigation") current = false;
      if (change === "recycle") root.links = [new LinkFixture(root, "https://x.com/alice/status/2")];
      if (change === "detach") root.isConnected = false;
      ready = true;
      await vi.advanceTimersByTimeAsync(50);
      expect((await action).ok).toBe(change === "valid");
      expect(menu.click).toHaveBeenCalledTimes(change === "valid" ? 1 : 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("chooses a primary photo permalink over a quoted timestamp link", () => {
    const root = card("1");
    root.links = [new LinkFixture(root, "https://x.com/alice/status/1/photo/1"), new LinkFixture(root, "https://x.com/bob/status/2", true, true)];
    expect(new XAdapter().getPermalink(asHandle(root))).toBe("https://x.com/alice/status/1");
    expect(new XAdapter().getProgressKey(asHandle(root))).toBe("1");
  });

  it("does not group different status IDs using unverified conversation attributes", () => {
    const root = card("1");
    const reply = card("2");
    reply.setAttribute("data-conversation-id", "1");
    const adapter = new XAdapter();
    expect(adapter.getProgressKey(asHandle(root))).toBe("1");
    expect(adapter.getProgressKey(asHandle(reply))).toBe("2");
    const unrelated = card("3");
    expect(adapter.getProgressKey(asHandle(unrelated))).toBe("3");
  });

  it("keeps the canonical status rather than guessing a root from link labels", () => {
    const reply = card("2");
    const thread = new LinkFixture(reply, "https://x.com/alice/status/1");
    thread.textContent = "Show this thread";
    reply.links.push(thread);
    expect(new XAdapter().getProgressKey(asHandle(reply))).toBe("2");
  });

  it.each(["Remove Bookmark", "Remove bookmark", "Unbookmark"])("makes Save idempotent for %s", (label) => {
    const root = card("1");
    const button = new ButtonFixture(root, "");
    button.setAttribute("aria-label", label);
    root.buttons = [button];
    expect(new XAdapter().bookmark(asHandle(root))).toEqual({ ok: true, message: "Post already bookmarked." });
    expect(button.click).not.toHaveBeenCalled();
  });

  it("clicks a primary Save control without clicking a quoted card's control", () => {
    const root = card("1");
    const save = new ButtonFixture(root, "");
    save.dataset.testid = "bookmark";
    const quoteSave = new ButtonFixture(root, "", false, true);
    quoteSave.dataset.testid = "bookmark";
    root.buttons = [quoteSave, save];
    expect(new XAdapter().bookmark(asHandle(root)).ok).toBe(true);
    expect(save.click).toHaveBeenCalledTimes(1);
    expect(quoteSave.click).not.toHaveBeenCalled();
  });

  it("does not detect organic body or quote text as an advertisement", () => {
    const root = card("1");
    root.textContent = "Ad";
    expect(isXAdUnit(root as unknown as HTMLElement)).toBe(false);
    const marker = new LinkFixture(root, "", false, true);
    marker.textContent = "Sponsored";
    root.markers = [marker];
    expect(isXAdUnit(root as unknown as HTMLElement)).toBe(false);
    marker.secondary = false;
    marker.body = true;
    expect(isXAdUnit(root as unknown as HTMLElement)).toBe(false);
    marker.body = false;
    expect(isXAdUnit(root as unknown as HTMLElement)).toBe(true);
  });

  it("detects link, timestamp, body-text and internal child mutations within existing cards", () => {
    const root = card("1");
    setupCards([root]);
    const records = [
      { type: "attributes", target: root.links[0], attributeName: "href" },
      { type: "characterData", target: { parentElement: root } },
      { type: "childList", target: root, addedNodes: [], removedNodes: [] }
    ];
    for (const record of records) {
      expect(hasXFeedMutation([{ addedNodes: [], removedNodes: [], ...record } as unknown as MutationRecord])).toBe(true);
    }
  });

  it("assigns a new fallback identity when a permalink-less card's content is recycled", () => {
    const root = card("1");
    root.links = [];
    setupCards([root]);
    const adapter = new XAdapter();
    const first = adapter.getFeedItems()[0].id;
    expect(adapter.getFeedItems()[0].id).toBe(first);
    root.textContent = "Replacement post";
    expect(adapter.getFeedItems()[0].id).not.toBe(first);
  });
});
