export const cssMaskUrl = (src: string): string => {
  const escaped = src.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `url("${escaped}")`;
};

export const GUEST_RAIL_ICON_MASK_SIZE = '84%';
