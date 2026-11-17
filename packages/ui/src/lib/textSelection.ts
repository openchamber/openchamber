export const hasTextSelectionInside = (
  container: { contains: (node: Node | null) => boolean } | null | undefined,
): boolean => {
  if (!container) {
    return false;
  }

  const selection = globalThis.window?.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  return container.contains(range.startContainer) || container.contains(range.endContainer);
};
