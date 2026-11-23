export type ZoneRect = { left: number; top: number; width: number; height: number };
export type ZoneDropTargets = { left: ZoneRect; right: ZoneRect; bottom: ZoneRect };
export type ZonePoint = { x: number; y: number };

const SIDE_TARGET_MAX = 280;
const SIDE_TARGET_SHARE = 0.28;
const BOTTOM_TARGET_MAX = 240;
const BOTTOM_TARGET_SHARE = 0.35;

export const computeZoneDropTargets = (row: ZoneRect, chatColumn: ZoneRect, bottomZone: ZoneRect | null = null): ZoneDropTargets => {
  const rowRight = row.left + row.width;
  const chatRight = chatColumn.left + chatColumn.width;
  const chatBottom = chatColumn.top + chatColumn.height;
  const bottomTop = bottomZone
    ? bottomZone.top
    : chatBottom - Math.min(BOTTOM_TARGET_MAX, chatColumn.height * BOTTOM_TARGET_SHARE);
  const strip = Math.min(SIDE_TARGET_MAX, row.width * SIDE_TARGET_SHARE, chatColumn.width / 4);
  const leftOccupied = chatColumn.left - row.left >= 1;
  const rightOccupied = rowRight - chatRight >= 1;
  const stripHeight = Math.max(0, bottomTop - row.top);
  const leftRight = leftOccupied ? chatColumn.left : row.left + strip;
  const rightLeft = rightOccupied ? chatRight : rowRight - strip;
  return {
    left: { left: row.left, top: row.top, width: leftRight - row.left, height: leftOccupied ? row.height : stripHeight },
    right: { left: rightLeft, top: row.top, width: rowRight - rightLeft, height: rightOccupied ? row.height : stripHeight },
    bottom: { left: chatColumn.left, top: bottomTop, width: chatColumn.width, height: Math.max(0, chatBottom - bottomTop) },
  };
};

export const computeCenterDropTargets = (row: ZoneRect, center: ZoneRect): ZoneDropTargets => {
  const rowRight = row.left + row.width;
  const centerRight = center.left + center.width;
  const strip = Math.min(SIDE_TARGET_MAX, row.width * SIDE_TARGET_SHARE, center.width / 4);
  const leftRight = center.left - row.left >= 1 ? center.left : row.left + strip;
  const rightLeft = rowRight - centerRight >= 1 ? centerRight : rowRight - strip;
  return {
    left: { left: row.left, top: row.top, width: leftRight - row.left, height: row.height },
    right: { left: rightLeft, top: row.top, width: rowRight - rightLeft, height: row.height },
    bottom: { left: leftRight, top: center.top, width: Math.max(0, rightLeft - leftRight), height: center.height },
  };
};

const intersect = (a: ZoneRect, b: ZoneRect): ZoneRect | null => {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
};

const insetLikeCard = (rect: ZoneRect): ZoneRect => ({
  left: rect.left + 6,
  top: rect.top,
  width: Math.max(0, rect.width - 12),
  height: Math.max(0, rect.height - 8),
});

export const computeZoneDropFrames = (
  targets: ZoneDropTargets,
  cards: { [Zone in keyof ZoneDropTargets]: ZoneRect | null },
): ZoneDropTargets => {
  const frame = (zone: keyof ZoneDropTargets): ZoneRect => {
    const card = cards[zone];
    return (card && intersect(card, targets[zone])) ?? insetLikeCard(targets[zone]);
  };
  return { left: frame('left'), right: frame('right'), bottom: frame('bottom') };
};

const contains = (rect: ZoneRect, point: ZonePoint): boolean => (
  point.x >= rect.left && point.x < rect.left + rect.width
  && point.y >= rect.top && point.y < rect.top + rect.height
);

export const hitTestZoneDropTargets = (targets: ZoneDropTargets, point: ZonePoint): keyof ZoneDropTargets | null => {
  if (contains(targets.bottom, point)) return 'bottom';
  if (contains(targets.left, point)) return 'left';
  if (contains(targets.right, point)) return 'right';
  return null;
};
