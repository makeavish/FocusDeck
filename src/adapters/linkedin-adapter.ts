import type { ActionResult, Adapter, PostHandle, PostMeta } from "@/types/adapter";

const DISABLED_MESSAGE = "LinkedIn adapter is disabled by default and supports strict mode only.";

export class LinkedInAdapter implements Adapter {
  readonly id = "linkedin";
  readonly name = "LinkedIn (Strict Mode Skeleton)";

  isSupportedUrl(url: string): boolean {
    try {
      return /(^|\.)linkedin\.com$/.test(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  getFeedItems(): PostHandle[] {
    return [...document.querySelectorAll<HTMLElement>("div.feed-shared-update-v2, div[data-urn]")].map((element, index) => ({
      id: element.getAttribute("data-urn") ?? `linkedin-${index}`,
      element
    }));
  }

  focusItem(handle: PostHandle): void {
    handle.element.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  getPostMeta(handle: PostHandle): PostMeta | null {
    const text = handle.element.textContent?.trim().replace(/\s+/g, " ") ?? "";

    if (!text) {
      return null;
    }

    return {
      id: handle.id,
      text,
      media: [],
      siteLabel: "LinkedIn"
    };
  }

  notInterested(): ActionResult {
    return { ok: false, message: DISABLED_MESSAGE };
  }

  bookmark(): ActionResult {
    return { ok: false, message: DISABLED_MESSAGE };
  }

  openDetails(): ActionResult {
    return { ok: false, message: DISABLED_MESSAGE };
  }

  openOriginal(): ActionResult {
    return { ok: false, message: DISABLED_MESSAGE };
  }
}
