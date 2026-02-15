import type { ActionResult, Adapter, PostHandle, PostMeta } from "@/types/adapter";

const POST_SELECTORS = ["shreddit-post", "div[data-testid='post-container']", "article[data-testid='post-container']"];

export class RedditAdapter implements Adapter {
  readonly id = "reddit";
  readonly name = "Reddit (Skeleton)";

  isSupportedUrl(url: string): boolean {
    try {
      return /(^|\.)reddit\.com$/.test(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  getFeedItems(): PostHandle[] {
    const nodes = POST_SELECTORS.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)]);

    return nodes.map((element, index) => ({
      id: element.id || element.getAttribute("data-testid") || `reddit-${index}`,
      element
    }));
  }

  focusItem(handle: PostHandle): void {
    handle.element.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  getPostMeta(handle: PostHandle): PostMeta | null {
    const title =
      handle.element.querySelector("h2")?.textContent?.trim() ??
      handle.element.querySelector("a[data-click-id='body']")?.textContent?.trim() ??
      "";

    if (!title) {
      return null;
    }

    return {
      id: handle.id,
      text: title,
      media: [],
      siteLabel: "Reddit"
    };
  }

  notInterested(): ActionResult {
    return { ok: false, message: "Reddit adapter does not implement Not interested yet." };
  }

  bookmark(): ActionResult {
    return { ok: false, message: "Reddit adapter does not implement Save yet." };
  }

  openDetails(handle: PostHandle): ActionResult {
    const commentsLink = handle.element.querySelector<HTMLAnchorElement>("a[href*='/comments/']");

    if (!commentsLink?.href) {
      return { ok: false, message: "Reddit comments link not found." };
    }

    window.open(commentsLink.href, "_blank", "noopener,noreferrer");
    return { ok: true };
  }

  openOriginal(handle: PostHandle): ActionResult {
    const outbound = handle.element.querySelector<HTMLAnchorElement>("a[data-click-id='body'], a[rel='noopener nofollow']");

    if (!outbound?.href) {
      return { ok: false, message: "Reddit outbound link not found." };
    }

    window.open(outbound.href, "_blank", "noopener,noreferrer");
    return { ok: true };
  }
}
