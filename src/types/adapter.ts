export type AdapterAction = "notInterested" | "bookmark";

export interface PostHandle {
  id: string;
  element: HTMLElement;
}

export type ImageMediaItem = {
  kind: "image";
  url: string;
  alt?: string;
};

export type VideoMediaItem = {
  kind: "video";
  posterUrl?: string;
  srcUrl?: string;
  sourceUrl?: string;
  durationLabel?: string;
};

export type MediaItem = ImageMediaItem | VideoMediaItem;

export interface QuotedPostMeta {
  author?: string;
  handle?: string;
  profileImageUrl?: string;
  text?: string;
  formattedTextHtml?: string;
  permalink?: string;
  timestamp?: string;
  media: MediaItem[];
}

export interface PostMeta {
  id: string;
  text: string;
  formattedTextHtml?: string;
  author?: string;
  handle?: string;
  profileImageUrl?: string;
  timestamp?: string;
  permalink?: string;
  media: MediaItem[];
  siteLabel: string;
  isRepost?: boolean;
  repostContext?: string;
  quoted?: QuotedPostMeta | null;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  undo?: () => void | Promise<void>;
}

export interface Adapter {
  id: string;
  name: string;
  isSupportedUrl(url: string): boolean;
  isFeedPage?(url: string): boolean;
  isDetailPage?(url: string): boolean;
  getFeedItems(): PostHandle[];
  findHandleById?(id: string): PostHandle | null;
  getProgressKey?(handle: PostHandle): string | null;
  isAdvertisement?(handle: PostHandle): boolean;
  focusItem(handle: PostHandle): void;
  getPostMeta(handle: PostHandle): PostMeta | null;
  notInterested(handle: PostHandle): ActionResult | Promise<ActionResult>;
  bookmark(handle: PostHandle): ActionResult | Promise<ActionResult>;
  openOriginal?(handle: PostHandle): ActionResult | Promise<ActionResult>;
  observeFeedChanges?(onChange: () => void): () => void;
  triggerLazyLoad?(handle?: PostHandle): void;
  pauseMedia?(handle?: PostHandle): void;
}
