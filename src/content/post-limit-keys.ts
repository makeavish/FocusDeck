export type PostLimitHandleKey = {
  handleId: string;
  progressKey: string | null;
};

export function isHandleViewedInPostLimit(viewedKeys: Set<string>, handleId: string, progressKey: string | null): boolean {
  return viewedKeys.has(handleId) || Boolean(progressKey && viewedKeys.has(progressKey));
}

export function expandPostLimitViewedKeys(
  viewedKeys: Set<string>,
  handles: readonly PostLimitHandleKey[]
): Set<string> {
  const expanded = new Set(viewedKeys);

  for (const handle of handles) {
    if (!handle.progressKey) {
      continue;
    }

    if (expanded.has(handle.handleId)) {
      expanded.add(handle.progressKey);
    }

    if (expanded.has(handle.progressKey)) {
      expanded.add(handle.handleId);
    }
  }

  return expanded;
}
