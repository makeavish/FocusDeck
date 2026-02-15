import type { ActionResult, Adapter, PostHandle, PostMeta } from "@/types/adapter";

export class HNAdapter implements Adapter {
  readonly id = "hn";
  readonly name = "Hacker News (Skeleton)";

  isSupportedUrl(url: string): boolean {
    try {
      return /news\.ycombinator\.com$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  getFeedItems(): PostHandle[] {
    return [...document.querySelectorAll<HTMLElement>("tr.athing")].map((element, index) => ({
      id: element.getAttribute("id") ?? `hn-${index}`,
      element
    }));
  }

  focusItem(handle: PostHandle): void {
    handle.element.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  getPostMeta(handle: PostHandle): PostMeta | null {
    const titleNode = handle.element.querySelector<HTMLAnchorElement>("span.titleline > a");

    if (!titleNode) {
      return null;
    }

    return {
      id: handle.id,
      text: titleNode.textContent?.trim() ?? "",
      author: undefined,
      handle: undefined,
      timestamp: undefined,
      permalink: titleNode.href,
      media: [],
      siteLabel: "Hacker News"
    };
  }

  notInterested(): ActionResult {
    return { ok: false, message: "Hacker News adapter does not implement Not interested yet." };
  }

  bookmark(): ActionResult {
    return { ok: false, message: "Hacker News adapter does not implement Save yet." };
  }

  openDetails(handle: PostHandle): ActionResult {
    const comments = handle.element.nextElementSibling?.querySelector<HTMLAnchorElement>("a[href*='item?id=']");

    if (!comments?.href) {
      return { ok: false, message: "HN comments link not found." };
    }

    window.open(comments.href, "_blank", "noopener,noreferrer");
    return { ok: true };
  }

  openOriginal(handle: PostHandle): ActionResult {
    const titleNode = handle.element.querySelector<HTMLAnchorElement>("span.titleline > a");

    if (!titleNode?.href) {
      return { ok: false, message: "HN story link not found." };
    }

    window.open(titleNode.href, "_blank", "noopener,noreferrer");
    return { ok: true };
  }
}
