import { KEY_BINDINGS } from "@/shared/constants";

export interface KeyboardHandlers {
  onNext: () => void;
  onPrevious: () => void;
  onBookmark: () => void;
  onNotInterested: () => void;
  onOpenPost: () => void;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
}

export function installKeyboardShortcuts(handlers: KeyboardHandlers): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (isEditable(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const key = event.key;

    if (KEY_BINDINGS.next.includes(key as (typeof KEY_BINDINGS.next)[number])) {
      event.preventDefault();
      handlers.onNext();
      return;
    }

    if (KEY_BINDINGS.previous.includes(key as (typeof KEY_BINDINGS.previous)[number])) {
      event.preventDefault();
      handlers.onPrevious();
      return;
    }

    if (KEY_BINDINGS.bookmark.includes(key as (typeof KEY_BINDINGS.bookmark)[number])) {
      event.preventDefault();
      handlers.onBookmark();
      return;
    }

    if (KEY_BINDINGS.notInterested.includes(key as (typeof KEY_BINDINGS.notInterested)[number])) {
      event.preventDefault();
      handlers.onNotInterested();
      return;
    }

    if (KEY_BINDINGS.openPost.includes(key as (typeof KEY_BINDINGS.openPost)[number])) {
      event.preventDefault();
      handlers.onOpenPost();
    }
  };

  window.addEventListener("keydown", onKeyDown, { capture: true });

  return () => {
    window.removeEventListener("keydown", onKeyDown, { capture: true });
  };
}
