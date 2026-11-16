export function getPinnedZoneHeaderHeight(root: HTMLElement): number {
  const layer = root.querySelector(':scope > [data-sidebar-crossfade-layer]');
  let height = 0;
  for (const child of layer?.children ?? []) height = Math.max(height, child.getBoundingClientRect().height);
  return height;
}
