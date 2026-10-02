import { afterEach, describe, expect, it, vi } from "vitest";
import { getXMutationCards } from "@/adapters/x-dom";

class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;

  constructor(readonly tag: string, readonly testid = "", parent: FakeElement | null = null) {
    if (parent) {
      this.parentElement = parent;
      parent.children.push(this);
    }
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const trimmed = part.trim();
      if (trimmed.startsWith("article")) return this.tag === "article";
      const testid = /data-testid='([^']+)'/.exec(trimmed)?.[1];
      return Boolean(testid) && this.testid === testid;
    });
  }

  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}

function record(target: FakeElement, addedNodes: FakeElement[] = []): MutationRecord {
  return { type: "childList", target, addedNodes, removedNodes: [] } as unknown as MutationRecord;
}

describe("getXMutationCards", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps mutations inside a nested quote to the outer feed card", () => {
    vi.stubGlobal("Element", FakeElement);
    const cell = new FakeElement("div", "cellInnerDiv");
    const outer = new FakeElement("article", "tweet", cell);
    const quoteBox = new FakeElement("div", "quoteTweet", outer);
    const quoted = new FakeElement("article", "tweet", quoteBox);
    const player = new FakeElement("div", "videoPlayer", quoted);

    expect([...getXMutationCards([record(player)])]).toEqual([outer]);
    expect([...getXMutationCards([record(cell, [outer])])]).toEqual([outer]);
  });

  it("ignores quote articles that have no outer feed card", () => {
    vi.stubGlobal("Element", FakeElement);
    const quoteBox = new FakeElement("div", "quoteTweet");
    const quoted = new FakeElement("article", "tweet", quoteBox);

    expect(getXMutationCards([record(quoted)]).size).toBe(0);
  });
});
