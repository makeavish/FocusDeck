import type { ActionResult, Adapter, MediaItem, PostHandle, PostMeta, QuotedPostMeta } from "@/types/adapter";

const PRIMARY_CARD_SELECTOR = "article[data-testid='tweet']";
const FALLBACK_CARD_SELECTOR = "article[role='article']";
const QUOTE_SELECTOR = "[data-testid='quoteTweet']";
const MEDIA_CONTAINER_SELECTOR =
  "[data-testid='tweetPhoto'], [data-testid='videoComponent'], [data-testid='videoPlayer'], [data-testid='card.wrapper'], [data-testid*='video'], a[href*='/video/']";
const HANDLE_ATTR = "data-focusdeck-id";

function textFrom(node: Element | null): string {
  return node?.textContent?.trim().replace(/\s+/g, " ") ?? "";
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function normalizeImageUrl(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) {
    return url;
  }

  if (parsed.hostname.includes("twimg.com") && parsed.searchParams.has("name")) {
    parsed.searchParams.set("name", "large");
  }

  return parsed.toString();
}

function openUrl(url: string): ActionResult {
  window.open(url, "_blank", "noopener,noreferrer");
  return { ok: true };
}

function owningTweet(node: Element): HTMLElement | null {
  return node.closest<HTMLElement>(PRIMARY_CARD_SELECTOR);
}

function belongsToTweet(node: Element, tweetRoot: HTMLElement): boolean {
  const owner = owningTweet(node);
  if (!owner) {
    return tweetRoot.contains(node);
  }

  return owner === tweetRoot;
}

function isInsideSecondary(root: HTMLElement, node: Element): boolean {
  if (node.closest(QUOTE_SELECTOR)) {
    return true;
  }

  const owner = owningTweet(node);
  return Boolean(owner && owner !== root);
}

function getScopedElements<T extends Element>(scope: ParentNode, selector: string, tweetRoot?: HTMLElement): T[] {
  const nodes = Array.from(scope.querySelectorAll<T>(selector));
  if (!tweetRoot) {
    return nodes;
  }

  return nodes.filter((node) => belongsToTweet(node, tweetRoot));
}

function filterPrimaryNodes<T extends Element>(nodes: T[], tweetRoot?: HTMLElement, primaryOnly = false): T[] {
  if (!primaryOnly || !tweetRoot) {
    return nodes;
  }

  return nodes.filter((node) => !isInsideSecondary(tweetRoot, node));
}

function getStatusLink(scope: ParentNode, tweetRoot?: HTMLElement, preferPrimary = false): HTMLAnchorElement | null {
  const links = getScopedElements<HTMLAnchorElement>(scope, "a[href*='/status/']", tweetRoot);

  const preferredLinks =
    preferPrimary && tweetRoot
      ? links.filter((link) => !isInsideSecondary(tweetRoot, link))
      : links;

  const timeLink = preferredLinks.find((link) => link.querySelector("time")) ?? links.find((link) => link.querySelector("time"));
  if (timeLink) {
    return timeLink;
  }

  if (preferredLinks[0]) {
    return preferredLinks[0];
  }

  return timeLink ?? links[0] ?? null;
}

function parseHandleFromPath(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  const first = segments[0];

  if (!first || ["i", "search", "home", "explore", "notifications", "messages"].includes(first)) {
    return undefined;
  }

  return first;
}

function getStatusIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/\/status\/(\d+)/);
  return match?.[1];
}

function getStatusIdFromUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }

  const parsed = parseUrl(url);
  if (!parsed) {
    return undefined;
  }

  return getStatusIdFromPath(parsed.pathname);
}

function isSameStatusUrl(a?: string, b?: string): boolean {
  const aId = getStatusIdFromUrl(a);
  const bId = getStatusIdFromUrl(b);

  if (aId && bId) {
    return aId === bId;
  }

  return Boolean(a && b && a === b);
}

function parseHandleFromPermalink(permalink?: string): string | undefined {
  if (!permalink) {
    return undefined;
  }

  const parsed = parseUrl(permalink);
  if (!parsed) {
    return undefined;
  }

  return parseHandleFromPath(parsed.pathname);
}

function getSecondaryStatusLinks(scope: ParentNode, tweetRoot?: HTMLElement, primaryPermalink?: string): HTMLAnchorElement[] {
  const primary = primaryPermalink ?? getStatusLink(scope, tweetRoot, true)?.href;
  const statusLinks = getScopedElements<HTMLAnchorElement>(scope, "a[href*='/status/']", tweetRoot);

  return statusLinks.filter((link) => {
    if (!link.href) {
      return false;
    }

    if (primary && isSameStatusUrl(link.href, primary)) {
      return false;
    }

    return true;
  });
}

function extractDurationLabel(scope: Element): string | undefined {
  const match = scope.textContent?.match(/\b\d{1,2}:\d{2}\b/);
  return match?.[0];
}

function extractVideoSrc(video: HTMLVideoElement | null): string | undefined {
  if (!video) {
    return undefined;
  }

  const direct = video.currentSrc || video.src;
  if (direct) {
    return direct;
  }

  const source = video.querySelector<HTMLSourceElement>("source[src]");
  return source?.src;
}

function isLikelyMediaImageUrl(url: string): boolean {
  if (!url) {
    return false;
  }

  const lowered = url.toLowerCase();

  if (lowered.includes("/profile_images/") || lowered.includes("emoji") || lowered.includes("abs-0.twimg.com") || lowered.includes("profile_banners")) {
    return false;
  }

  return true;
}

function isLikelyProfileImageUrl(url: string): boolean {
  if (!url) {
    return false;
  }

  const lowered = url.toLowerCase();
  return lowered.includes("/profile_images/") || lowered.includes("default_profile_images");
}

function sortByDomOrder<T extends Element>(elements: T[]): T[] {
  return [...elements].sort((left, right) => {
    if (left === right) {
      return 0;
    }

    const position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }

    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }

    return 0;
  });
}

function isVideoLikeContainer(container: Element): boolean {
  if (container.matches("a[href*='/video/'], [data-testid*='video'], [data-testid='videoComponent'], [data-testid='videoPlayer']")) {
    return true;
  }

  if (container.matches("[data-testid='videoComponent']")) {
    return true;
  }

  if (container.querySelector("video")) {
    return true;
  }

  if (container.querySelector("a[href*='/video/']")) {
    return true;
  }

  if (container.querySelector("[data-testid*='play'], [aria-label*='Play'], [aria-label*='play']")) {
    return true;
  }

  return Boolean(extractDurationLabel(container) && container.querySelector("img[src]"));
}

function resolveVideoSourceFromScope(scopeVideos: HTMLVideoElement[], posterUrl?: string): string | undefined {
  if (posterUrl) {
    const matchingByPoster = scopeVideos.find((video) => normalizeImageUrl(video.poster || "") === posterUrl);
    const matchedSource = extractVideoSrc(matchingByPoster ?? null);

    if (matchedSource) {
      return matchedSource;
    }
  }

  for (const video of scopeVideos) {
    const source = extractVideoSrc(video);
    if (source) {
      return source;
    }
  }

  return undefined;
}

function collectMediaItems(scope: ParentNode, tweetRoot?: HTMLElement, primaryOnly = false): MediaItem[] {
  const containerCandidates = filterPrimaryNodes(
    getScopedElements<HTMLElement>(scope, MEDIA_CONTAINER_SELECTOR, tweetRoot),
    tweetRoot,
    primaryOnly
  );
  const fallbackSourceUrl = getStatusLink(scope, tweetRoot, true)?.href;
  const firstSecondaryStatusLink = primaryOnly ? getSecondaryStatusLinks(scope, tweetRoot, fallbackSourceUrl)[0] : undefined;
  const allContainers = sortByDomOrder(
    containerCandidates.map(
      (node) =>
        node.closest<HTMLElement>(
          "[data-testid='tweetPhoto'], [data-testid='videoComponent'], [data-testid='videoPlayer'], [data-testid='card.wrapper'], [data-testid*='video']"
        ) ?? node
    )
  ).filter((node, index, all) => all.indexOf(node) === index);
  const containers = firstSecondaryStatusLink
    ? allContainers.filter((container) => Boolean(container.compareDocumentPosition(firstSecondaryStatusLink) & Node.DOCUMENT_POSITION_FOLLOWING))
    : allContainers;

  const dedupe = new Set<string>();
  const media: MediaItem[] = [];
  const allScopeVideos = filterPrimaryNodes(getScopedElements<HTMLVideoElement>(scope, "video", tweetRoot), tweetRoot, primaryOnly);
  const scopeVideos = firstSecondaryStatusLink
    ? allScopeVideos.filter((video) => Boolean(video.compareDocumentPosition(firstSecondaryStatusLink) & Node.DOCUMENT_POSITION_FOLLOWING))
    : allScopeVideos;

  for (const container of containers) {
    const durationLabel = extractDurationLabel(container);
    const videoLike = isVideoLikeContainer(container);

    if (videoLike) {
      const video = container.querySelector<HTMLVideoElement>("video");
      const posterRaw = video?.poster || container.querySelector<HTMLImageElement>("img[src]")?.src;
      const posterUrl = posterRaw ? normalizeImageUrl(posterRaw) : undefined;
      const sourceUrl = container.querySelector<HTMLAnchorElement>("a[href*='/video/']")?.href ?? fallbackSourceUrl;
      const srcUrl = extractVideoSrc(video) ?? resolveVideoSourceFromScope(scopeVideos, posterUrl);

      if (!srcUrl && !posterUrl) {
        continue;
      }

      const key = `video:${srcUrl ?? ""}:${posterUrl ?? ""}:${sourceUrl ?? ""}`;
      if (dedupe.has(key)) {
        continue;
      }

      dedupe.add(key);
      media.push({ kind: "video", srcUrl, posterUrl, sourceUrl, durationLabel });
      continue;
    }

    const images = Array.from(container.querySelectorAll<HTMLImageElement>("img[src]"));
    for (const image of images) {
      if (image.closest("a[href*='/video/'], [data-testid='videoComponent'], [data-testid='videoPlayer'], [data-testid*='video']")) {
        continue;
      }

      if (!isLikelyMediaImageUrl(image.src)) {
        continue;
      }

      const normalizedUrl = normalizeImageUrl(image.src);
      const key = `image:${normalizedUrl}`;

      if (dedupe.has(key)) {
        continue;
      }

      dedupe.add(key);
      media.push({
        kind: "image",
        url: normalizedUrl,
        alt: image.alt || undefined
      });
    }
  }

  if (!media.some((item) => item.kind === "video")) {
    for (const video of scopeVideos) {
      const posterUrl = video.poster ? normalizeImageUrl(video.poster) : undefined;
      const srcUrl = extractVideoSrc(video) ?? resolveVideoSourceFromScope(scopeVideos, posterUrl);
      const container = video.closest<HTMLElement>(MEDIA_CONTAINER_SELECTOR) ?? video.parentElement ?? undefined;
      const sourceUrl = container?.querySelector<HTMLAnchorElement>("a[href*='/video/']")?.href ?? fallbackSourceUrl;
      const durationLabel = container ? extractDurationLabel(container) : undefined;

      if (!srcUrl && !posterUrl) {
        continue;
      }

      const key = `video:${srcUrl ?? ""}:${posterUrl ?? ""}:${sourceUrl ?? ""}`;
      if (dedupe.has(key)) {
        continue;
      }

      dedupe.add(key);
      media.push({ kind: "video", srcUrl, posterUrl, sourceUrl, durationLabel });
    }
  }

  return media;
}

function extractProfileImageUrl(scope: ParentNode, tweetRoot?: HTMLElement, primaryOnly = false): string | undefined {
  const candidates = filterPrimaryNodes(
    getScopedElements<HTMLImageElement>(scope, "[data-testid='Tweet-User-Avatar'] img[src], img[src]", tweetRoot),
    tweetRoot,
    primaryOnly
  );

  const avatarCandidate = candidates.find(
    (img) =>
      isLikelyProfileImageUrl(img.src) &&
      !img.closest(
        "[data-testid='tweetPhoto'], [data-testid='videoComponent'], [data-testid='videoPlayer'], [data-testid='card.wrapper'], [data-testid*='video']"
      )
  );

  if (!avatarCandidate?.src) {
    return undefined;
  }

  return normalizeImageUrl(avatarCandidate.src);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") {
      return "&amp;";
    }

    if (char === "<") {
      return "&lt;";
    }

    if (char === ">") {
      return "&gt;";
    }

    if (char === '"') {
      return "&quot;";
    }

    return "&#39;";
  });
}

function serializeTweetText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeHtml(node.textContent ?? "");
  }

  if (!(node instanceof Element)) {
    return "";
  }

  if (node.getAttribute("aria-hidden") === "true") {
    return "";
  }

  if (node.tagName === "BR") {
    return "<br>";
  }

  if (node.tagName === "IMG") {
    return escapeHtml((node as HTMLImageElement).alt || "");
  }

  const content = Array.from(node.childNodes)
    .map((child) => serializeTweetText(child))
    .join("");

  if (node.tagName === "A") {
    const anchor = node as HTMLAnchorElement;
    const href = anchor.href;
    const linkText = content || escapeHtml(anchor.textContent ?? "");

    if (!href) {
      return linkText;
    }

    return `<a href="${escapeHtml(href)}">${linkText}</a>`;
  }

  return content;
}

interface CollectedTweetText {
  text: string;
  formattedTextHtml?: string;
}

function collectTweetText(scope: ParentNode, tweetRoot?: HTMLElement, primaryOnly = false): CollectedTweetText {
  const candidateTextNodes = filterPrimaryNodes(getScopedElements<HTMLElement>(scope, "div[data-testid='tweetText']", tweetRoot), tweetRoot, primaryOnly);
  const primaryPermalink = primaryOnly ? getStatusLink(scope, tweetRoot, true)?.href : undefined;
  const firstSecondaryStatusLink = primaryOnly ? getSecondaryStatusLinks(scope, tweetRoot, primaryPermalink)[0] : undefined;
  const textNodes =
    firstSecondaryStatusLink && candidateTextNodes.length > 1
      ? candidateTextNodes.filter((node) => Boolean(node.compareDocumentPosition(firstSecondaryStatusLink) & Node.DOCUMENT_POSITION_FOLLOWING))
      : candidateTextNodes;
  const normalizedTextNodes = primaryOnly && textNodes.length > 1 ? [textNodes[0]] : textNodes;

  const textParts = normalizedTextNodes.map((node) => node.innerText.trim()).filter(Boolean);
  const htmlParts = normalizedTextNodes
    .map((node) =>
      Array.from(node.childNodes)
        .map((child) => serializeTweetText(child))
        .join("")
        .trim()
    )
    .filter(Boolean);

  return {
    text: textParts.join("\n\n"),
    formattedTextHtml: htmlParts.length ? htmlParts.join("<br><br>") : undefined
  };
}

interface ParsedTweet {
  author?: string;
  handle?: string;
  profileImageUrl?: string;
  text?: string;
  formattedTextHtml?: string;
  permalink?: string;
  timestamp?: string;
  media: MediaItem[];
}

function extractAuthorAndHandle(scope: ParentNode, tweetRoot: HTMLElement | undefined, permalink?: string): { author?: string; handle?: string } {
  const authorBlock = getScopedElements<HTMLElement>(scope, "div[data-testid='User-Name']", tweetRoot)[0] ?? null;
  let handle = parseHandleFromPermalink(permalink);
  let author: string | undefined;

  if (authorBlock) {
    const spanTexts = Array.from(authorBlock.querySelectorAll("span"))
      .map((span) => textFrom(span))
      .filter(Boolean);

    for (const token of spanTexts) {
      if (token.startsWith("@")) {
        handle = handle ?? token.slice(1);
        continue;
      }

      if (token === "·" || /^Follow$/i.test(token) || /^Following$/i.test(token)) {
        continue;
      }

      if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(token) || /^\d{1,2}:\d{2}$/.test(token)) {
        continue;
      }

      author = token;
      break;
    }

    if (!handle) {
      const anchors = Array.from(authorBlock.querySelectorAll<HTMLAnchorElement>("a[href]"));
      for (const anchor of anchors) {
        const parsed = parseUrl(anchor.href);
        const nextHandle = parsed ? parseHandleFromPath(parsed.pathname) : undefined;
        if (nextHandle) {
          handle = nextHandle;
          break;
        }
      }
    }
  }

  if (!author && handle) {
    author = handle;
  }

  return { author, handle };
}

function parseTweet(scope: ParentNode, tweetRoot?: HTMLElement): ParsedTweet {
  const permalinkNode = getStatusLink(scope, tweetRoot, Boolean(tweetRoot));
  const permalink = permalinkNode?.href;
  const textContent = collectTweetText(scope, tweetRoot, Boolean(tweetRoot));
  const authorAndHandle = extractAuthorAndHandle(scope, tweetRoot, permalink);

  return {
    author: authorAndHandle.author,
    handle: authorAndHandle.handle,
    profileImageUrl: extractProfileImageUrl(scope, tweetRoot, Boolean(tweetRoot)),
    text: textContent.text || undefined,
    formattedTextHtml: textContent.formattedTextHtml,
    permalink,
    timestamp: permalinkNode?.querySelector("time")?.getAttribute("datetime") ?? undefined,
    media: collectMediaItems(scope, tweetRoot, Boolean(tweetRoot))
  };
}

function findQuotedContainerFromStatusLink(root: HTMLElement, link: HTMLAnchorElement): HTMLElement | null {
  if (link.closest(QUOTE_SELECTOR)) {
    return link.closest<HTMLElement>(QUOTE_SELECTOR);
  }

  const nestedTweet = link.closest<HTMLElement>(PRIMARY_CARD_SELECTOR);
  if (nestedTweet && nestedTweet !== root) {
    return nestedTweet;
  }

  let cursor = link.parentElement;
  while (cursor && cursor !== root) {
    const hasUserName = Boolean(cursor.querySelector("div[data-testid='User-Name']"));
    const hasText = Boolean(cursor.querySelector("div[data-testid='tweetText']"));
    const hasMedia = Boolean(cursor.querySelector(MEDIA_CONTAINER_SELECTOR));

    if ((hasText || hasMedia) && (hasUserName || hasText)) {
      return cursor;
    }

    cursor = cursor.parentElement;
  }

  return null;
}

function parseQuotedMeta(root: HTMLElement): QuotedPostMeta | null {
  const nestedTweet = Array.from(root.querySelectorAll<HTMLElement>(PRIMARY_CARD_SELECTOR))[0] ?? null;

  if (nestedTweet) {
    const parsed = parseTweet(nestedTweet, nestedTweet);
    if (!parsed.text && !parsed.media.length) {
      return null;
    }

    return {
      author: parsed.author,
      handle: parsed.handle,
      profileImageUrl: parsed.profileImageUrl,
      text: parsed.text,
      formattedTextHtml: parsed.formattedTextHtml,
      permalink: parsed.permalink,
      timestamp: parsed.timestamp,
      media: parsed.media
    };
  }

  const quoteContainer = root.querySelector<HTMLElement>(QUOTE_SELECTOR);
  if (!quoteContainer) {
    const primaryPermalink = getStatusLink(root, root, true)?.href;
    const secondaryStatusLink = getSecondaryStatusLinks(root, root, primaryPermalink)[0];

    if (!secondaryStatusLink) {
      return null;
    }

    const secondaryContainer = findQuotedContainerFromStatusLink(root, secondaryStatusLink);
    if (!secondaryContainer) {
      return null;
    }

    const parsed = parseTweet(secondaryContainer);
    const permalink = parsed.permalink ?? secondaryStatusLink.href;
    const handle = parsed.handle ?? parseHandleFromPermalink(permalink);

    if (!parsed.text && !parsed.media.length && !parsed.author && !handle) {
      return null;
    }

    return {
      author: parsed.author ?? handle,
      handle,
      profileImageUrl: parsed.profileImageUrl,
      text: parsed.text,
      formattedTextHtml: parsed.formattedTextHtml,
      permalink,
      timestamp: parsed.timestamp ?? secondaryStatusLink.querySelector("time")?.getAttribute("datetime") ?? undefined,
      media: parsed.media
    };
  }

  const parsed = parseTweet(quoteContainer);
  if (!parsed.text && !parsed.media.length) {
    return null;
  }

  return {
    author: parsed.author,
    handle: parsed.handle,
    profileImageUrl: parsed.profileImageUrl,
    text: parsed.text,
    formattedTextHtml: parsed.formattedTextHtml,
    permalink: parsed.permalink,
    timestamp: parsed.timestamp,
    media: parsed.media
  };
}

function findMenuItem(...patterns: RegExp[]): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>("[role='menuitem'], div[role='menuitem']");

  for (const candidate of candidates) {
    const content = candidate.textContent ?? "";
    if (patterns.some((pattern) => pattern.test(content))) {
      return candidate;
    }
  }

  return null;
}

function waitForMenuItem(timeoutMs = 1200): Promise<HTMLElement | null> {
  const started = Date.now();

  return new Promise((resolve) => {
    const tick = () => {
      const found = findMenuItem(/Not interested/i, /Show fewer/i, /This post isn't relevant/i);

      if (found) {
        resolve(found);
        return;
      }

      if (Date.now() - started >= timeoutMs) {
        resolve(null);
        return;
      }

      window.setTimeout(tick, 50);
    };

    tick();
  });
}

function isExternalCandidate(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) {
    return false;
  }

  const isInternal = /(^|\.)x\.com$/i.test(parsed.hostname) || /(^|\.)twitter\.com$/i.test(parsed.hostname);
  if (!isInternal) {
    return true;
  }

  const path = parsed.pathname;
  if (path.includes("/status/") || path.includes("/photo/") || path.includes("/video/")) {
    return false;
  }

  if (path.startsWith("/hashtag/") || path.startsWith("/search") || path.startsWith("/i/")) {
    return false;
  }

  return false;
}

function createHandleId(element: HTMLElement, index: number): string {
  const permalink = getStatusLink(element, element, true)?.href;
  const statusId = getStatusIdFromUrl(permalink);
  const canonical = statusId ? `x-status-${statusId}` : permalink;

  if (canonical) {
    element.setAttribute(HANDLE_ATTR, canonical);
    return canonical;
  }

  const existing = element.getAttribute(HANDLE_ATTR);
  if (existing) {
    return existing;
  }

  const generated = `x-${Date.now()}-${index}`;
  element.setAttribute(HANDLE_ATTR, generated);
  return generated;
}

function isPromotedTweet(root: HTMLElement): boolean {
  const promotedNode = Array.from(root.querySelectorAll<HTMLElement>("span, div")).find((node) => {
    const text = node.textContent?.trim() ?? "";
    return /^Promoted$/i.test(text) || /^Ad$/i.test(text);
  });

  return Boolean(promotedNode);
}

function isReplyTweet(root: HTMLElement): boolean {
  const markers = getScopedElements<HTMLElement>(root, "span, a, div[dir='ltr']", root).filter(
    (node) => !isInsideSecondary(root, node)
  );

  const joined = markers
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");

  return /\bReplying to\b/i.test(joined);
}

function isLikelyFeedPost(root: HTMLElement): boolean {
  const hasPrimaryStatus = Boolean(getStatusLink(root, root, true));
  const hasTweetText = Boolean(root.querySelector("div[data-testid='tweetText']"));
  const hasMedia = Boolean(root.querySelector(MEDIA_CONTAINER_SELECTOR));
  const hasActionRow = Boolean(root.querySelector("[role='group']"));
  const hasUserMarker = Boolean(root.querySelector("[data-testid='User-Name'], a[href*='/status/'] time"));

  return hasPrimaryStatus || hasTweetText || hasMedia || (hasActionRow && hasUserMarker);
}

function isFeedPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/home" ||
    pathname.startsWith("/i/bookmarks") ||
    pathname.startsWith("/i/lists/") ||
    pathname.startsWith("/search") ||
    pathname.startsWith("/explore")
  );
}

function isDetailPath(pathname: string): boolean {
  return pathname.includes("/status/") || pathname.includes("/photo/") || pathname.includes("/video/");
}

export class XAdapter implements Adapter {
  readonly id = "x";
  readonly name = "X / Twitter";

  isSupportedUrl(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      return /(^|\.)x\.com$/.test(hostname) || /(^|\.)twitter\.com$/.test(hostname);
    } catch {
      return false;
    }
  }

  isFeedPage(url: string): boolean {
    try {
      return this.isSupportedUrl(url) && isFeedPath(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  isDetailPage(url: string): boolean {
    try {
      return this.isSupportedUrl(url) && isDetailPath(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  findHandleById(id: string): PostHandle | null {
    const handles = this.getFeedItems();
    return handles.find((item) => item.id === id) ?? null;
  }

  getProgressKey(handle: PostHandle): string | null {
    if (isPromotedTweet(handle.element)) {
      return null;
    }

    const permalink = getStatusLink(handle.element, handle.element, true)?.href;
    const statusId = getStatusIdFromUrl(permalink);
    if (statusId) {
      return statusId;
    }

    if (isReplyTweet(handle.element)) {
      return null;
    }

    return handle.id;
  }

  isAdvertisement(handle: PostHandle): boolean {
    return isPromotedTweet(handle.element);
  }

  getFeedItems(): PostHandle[] {
    const primaryNodes = [...document.querySelectorAll<HTMLElement>(PRIMARY_CARD_SELECTOR)];
    const sourceNodes = primaryNodes.length ? primaryNodes : [...document.querySelectorAll<HTMLElement>(FALLBACK_CARD_SELECTOR)];

    const nodes = sourceNodes.filter((element) => {
      if (element.parentElement?.closest(PRIMARY_CARD_SELECTOR)) {
        return false;
      }

      if (!element.closest("[data-testid='primaryColumn'], main")) {
        return false;
      }

      if (isPromotedTweet(element)) {
        return false;
      }

      return isLikelyFeedPost(element);
    });

    const seen = new Set<string>();
    const handles: PostHandle[] = [];

    nodes.forEach((element, index) => {
      const id = createHandleId(element, index);

      if (seen.has(id)) {
        return;
      }

      seen.add(id);
      handles.push({ id, element });
    });

    return handles;
  }

  focusItem(handle: PostHandle): void {
    handle.element.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest"
    });
  }

  getPostMeta(handle: PostHandle): PostMeta | null {
    const root = handle.element;
    const parsedMain = parseTweet(root, root);
    const quoted = parseQuotedMeta(root);

    const repostContext = textFrom(root.querySelector("div[data-testid='socialContext']"));
    const isRepost = Boolean(repostContext);

    const text = parsedMain.text || (isRepost ? "Shared a post" : quoted?.text ?? "");
    const formattedTextHtml = parsedMain.formattedTextHtml || (!isRepost ? quoted?.formattedTextHtml : undefined);

    if (!text && !parsedMain.media.length && !quoted) {
      return null;
    }

    return {
      id: handle.id,
      text,
      formattedTextHtml,
      author: parsedMain.author,
      handle: parsedMain.handle,
      profileImageUrl: parsedMain.profileImageUrl,
      timestamp: parsedMain.timestamp,
      permalink: parsedMain.permalink,
      media: parsedMain.media,
      siteLabel: isRepost ? "X/Twitter · Repost" : "X/Twitter",
      isRepost,
      repostContext: repostContext || undefined,
      quoted
    };
  }

  async notInterested(handle: PostHandle): Promise<ActionResult> {
    const caretButton =
      handle.element.querySelector<HTMLElement>("button[data-testid='caret']") ??
      handle.element.querySelector<HTMLElement>("button[aria-label*='More']");

    if (!caretButton) {
      return { ok: false, message: "Unable to locate the post menu." };
    }

    caretButton.click();

    const target = await waitForMenuItem();
    if (!target) {
      return {
        ok: false,
        message: this.assistMissingMenuAction()
      };
    }

    target.click();

    return {
      ok: true,
      message: "Marked as not interested."
    };
  }

  bookmark(handle: PostHandle): ActionResult {
    const bookmarkButton =
      handle.element.querySelector<HTMLElement>("button[data-testid='bookmark']") ??
      handle.element.querySelector<HTMLElement>("button[aria-label*='Bookmark']");

    if (!bookmarkButton) {
      return { ok: false, message: this.assistMissingBookmark(handle) };
    }

    bookmarkButton.click();

    return {
      ok: true,
      message: "Post bookmarked.",
      undo: () => {
        const undoButton =
          handle.element.querySelector<HTMLElement>("button[data-testid='removeBookmark']") ??
          handle.element.querySelector<HTMLElement>("button[data-testid='unbookmark']") ??
          handle.element.querySelector<HTMLElement>("button[aria-label*='Remove Bookmark']");

        undoButton?.click();
      }
    };
  }

  openDetails(handle: PostHandle): ActionResult {
    const threadLink = getStatusLink(handle.element, handle.element, true) ?? getStatusLink(handle.element);

    if (!threadLink?.href) {
      return { ok: false, message: "Thread URL was not found." };
    }

    threadLink.click();
    return { ok: true, message: "Opened details." };
  }

  openOriginal(handle: PostHandle): ActionResult {
    const root = handle.element;
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"));

    const externalOutsideQuote = links.find((anchor) => !isInsideSecondary(root, anchor) && isExternalCandidate(anchor.href));
    if (externalOutsideQuote?.href) {
      return openUrl(externalOutsideQuote.href);
    }

    const externalFromQuote = links.find((anchor) => isExternalCandidate(anchor.href));
    if (externalFromQuote?.href) {
      return openUrl(externalFromQuote.href);
    }

    return this.openDetails(handle);
  }

  observeFeedChanges(onChange: () => void): () => void {
    const target = document.querySelector("main") ?? document.body;
    let rafId = 0;

    const observer = new MutationObserver(() => {
      if (rafId) {
        return;
      }

      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        onChange();
      });
    });

    observer.observe(target, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }

  triggerLazyLoad(): void {
    window.scrollBy({ top: Math.floor(window.innerHeight * 0.8), behavior: "smooth" });
  }

  pauseMedia(): void {
    document.querySelectorAll<HTMLVideoElement>("video").forEach((video) => {
      video.pause();
    });
  }

  private assistMissingMenuAction(): string {
    const fallback = document.querySelector<HTMLElement>("[role='menuitem']");
    if (fallback) {
      fallback.style.outline = "2px solid #1a62d6";
      fallback.style.outlineOffset = "2px";
      window.setTimeout(() => {
        fallback.style.removeProperty("outline");
        fallback.style.removeProperty("outline-offset");
      }, 1200);
    }

    return "Action not found—X UI changed.";
  }

  private assistMissingBookmark(handle: PostHandle): string {
    const actionGroup = handle.element.querySelector<HTMLElement>("[role='group']");
    if (actionGroup) {
      actionGroup.style.outline = "2px solid #1a62d6";
      actionGroup.style.outlineOffset = "2px";
      window.setTimeout(() => {
        actionGroup.style.removeProperty("outline");
        actionGroup.style.removeProperty("outline-offset");
      }, 1200);
    }

    return "Action not found—X UI changed.";
  }
}
