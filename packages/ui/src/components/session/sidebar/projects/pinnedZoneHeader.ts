/**
 * How much of the scroller's top the pinned zone header covers; 0 when none
 * is pinned. `CrossfadeZoneHeaders` moves the pinned header into its layer, a
 * zero-height sticky element at the top of the scroller.
 */
export function getPinnedZoneHeaderHeight(root: HTMLElement): number {
  const layer = root.querySelector(':scope > [data-sidebar-crossfade-layer]');
  let height = 0;
  for (const child of layer?.children ?? []) height = Math.max(height, child.getBoundingClientRect().height);
  return height;
}
