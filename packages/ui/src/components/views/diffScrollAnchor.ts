export type DiffScrollAnchor = {
  path: string;
  topOffset: number;
};

export const findDiffScrollAnchor = (
  rootTop: number,
  sections: Array<{ path: string; top: number }>,
): DiffScrollAnchor | null => {
  if (sections.length === 0) return null;

  let beforeTop: { path: string; top: number } | null = null;
  let afterTop: { path: string; top: number } | null = null;
  for (const section of sections) {
    if (section.top <= rootTop) {
      if (!beforeTop || section.top > beforeTop.top) beforeTop = section;
    } else if (!afterTop || section.top < afterTop.top) {
      afterTop = section;
    }
  }

  const anchor = beforeTop ?? afterTop;
  if (!anchor) return null;
  return { path: anchor.path, topOffset: anchor.top - rootTop };
};

export const getRestoredDiffScrollTop = (
  scrollTop: number,
  previousTopOffset: number,
  currentTopOffset: number,
  maxScrollTop: number,
): number => Math.min(
  Math.max(0, maxScrollTop),
  Math.max(0, scrollTop + currentTopOffset - previousTopOffset),
);
