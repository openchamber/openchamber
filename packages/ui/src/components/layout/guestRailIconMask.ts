export const cssMaskUrl = (src: string): string => {
  const escaped = src.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `url("${escaped}")`;
};

/**
 * Package brand SVGs usually fill the 24×24 viewBox; Remixicon glyphs keep ~2px
 * inset. Scale the mask so a guest mark matches host rail icons at the same box.
 */
export const GUEST_RAIL_ICON_MASK_SIZE = '84%';
