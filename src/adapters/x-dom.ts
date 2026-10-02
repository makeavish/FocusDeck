export const X_CARD_SELECTOR = "article[data-testid='tweet'], article[role='article']";
export const X_FEED_MUTATION_ATTRIBUTES = ["aria-selected", "href", "datetime", "data-testid", "aria-label"];
const FEED_STRUCTURE_SELECTOR = `${X_CARD_SELECTOR}, [data-testid='cellInnerDiv'], [data-testid='placementTracking'], [data-testid='primaryColumn'], main, [role='tab']`;
const POST_CONTENT_SELECTOR = "[data-testid='tweetText'], [data-testid='User-Name'], [data-testid='quoteTweet']";

export function isXAdUnit(root: HTMLElement): boolean {
  const outsideContent = (node: Element) => !node.closest(POST_CONTENT_SELECTOR) &&
    !node.closest("[data-testid='quoteTweet']") &&
    !node.closest(X_CARD_SELECTOR)?.parentElement?.closest(X_CARD_SELECTOR);
  const markers = root.querySelectorAll<HTMLElement>(
    "[data-testid='promotedIndicator'], [data-testid='promotedTweet'], [aria-label='Ad'], [aria-label='Promoted'], [aria-label='Sponsored']"
  );
  if (Array.from(markers).some(outsideContent)) {
    return true;
  }
  // X also wraps in-post video players in placementTracking; only a wrapper outside any post marks an ad unit.
  const tracking = root.closest<HTMLElement>("[data-testid='placementTracking']");
  return Boolean(tracking && !tracking.parentElement?.closest(X_CARD_SELECTOR));
}

export function hasXFeedMutation(records: MutationRecord[]): boolean {
  const touchesStructure = (node: Node) => node instanceof Element &&
    (node.matches(FEED_STRUCTURE_SELECTOR) || Boolean(node.querySelector(FEED_STRUCTURE_SELECTOR)));
  return records.some((record) => {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (target?.closest(`${X_CARD_SELECTOR}, [role='tab']`)) {
      return true;
    }
    return [...record.addedNodes, ...record.removedNodes].some(touchesStructure) ||
      (record.type === "attributes" && Boolean(target?.matches(FEED_STRUCTURE_SELECTOR)));
  });
}

// Nested quote articles aren't feed items, so map each card to the outer card getFeedItems manages.
function toFeedCard(card: HTMLElement): HTMLElement | null {
  let current = card;
  let outer = current.parentElement?.closest<HTMLElement>(X_CARD_SELECTOR) ?? null;
  while (outer) {
    current = outer;
    outer = current.parentElement?.closest<HTMLElement>(X_CARD_SELECTOR) ?? null;
  }
  return current.closest("[data-testid='quoteTweet']") ? null : current;
}

export function getXMutationCards(records: MutationRecord[]): Set<HTMLElement> {
  const cards = new Set<HTMLElement>();
  const add = (card: HTMLElement | null | undefined) => {
    const feedCard = card ? toFeedCard(card) : null;
    if (feedCard) cards.add(feedCard);
  };
  for (const record of records) {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    add(target?.closest<HTMLElement>(X_CARD_SELECTOR));
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches(X_CARD_SELECTOR)) add(node as HTMLElement);
      node.querySelectorAll<HTMLElement>(X_CARD_SELECTOR).forEach(add);
    }
  }
  return cards;
}
