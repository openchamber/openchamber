import type { SessionSidebarRow } from './sessionSidebarRowModel';


const disclosureOpen = (row: SessionSidebarRow): boolean | null => {
  switch (row.kind) {
    case 'activity-header':
    case 'caption':
    case 'project-header':
    case 'group-header':
    case 'folder-header':
      return !row.collapsed;
    case 'run':
      return row.expanded;
    case 'session':
      return row.expanded ?? null;
    default:
      return null;
  }
};

type SessionSidebarDisclosure = {
  opened: boolean;
  previousHeaderIndex: number;
  nextHeaderIndex: number;
  blockStart: number;
  blockEnd: number;
};

export const findSessionSidebarDisclosure = (
  previous: readonly SessionSidebarRow[],
  next: readonly SessionSidebarRow[],
): SessionSidebarDisclosure | null => {
  if (previous === next) return null;
  const previousIndexByKey = new Map(previous.map((row, index) => [row.key, index]));
  let toggled: { previousIndex: number; nextIndex: number; opened: boolean } | null = null;
  for (let nextIndex = 0; nextIndex < next.length; nextIndex += 1) {
    const open = disclosureOpen(next[nextIndex]);
    if (open === null) continue;
    const previousIndex = previousIndexByKey.get(next[nextIndex].key);
    if (previousIndex === undefined) continue;
    const wasOpen = disclosureOpen(previous[previousIndex]);
    if (wasOpen === null || wasOpen === open) continue;
    if (toggled) return null;
    toggled = { previousIndex, nextIndex, opened: open };
  }
  if (!toggled) return null;

  const [withBlock, withoutBlock, headerWith, headerWithout] = toggled.opened
    ? [next, previous, toggled.nextIndex, toggled.previousIndex]
    : [previous, next, toggled.previousIndex, toggled.nextIndex];
  const followingKey = withoutBlock[headerWithout + 1]?.key ?? null;
  const blockStart = headerWith + 1;
  let blockEnd = blockStart;
  while (blockEnd < withBlock.length && withBlock[blockEnd].key !== followingKey) blockEnd += 1;
  if (followingKey !== null && blockEnd === withBlock.length) return null;
  if (blockEnd === blockStart) return null;
  return {
    opened: toggled.opened,
    previousHeaderIndex: toggled.previousIndex,
    nextHeaderIndex: toggled.nextIndex,
    blockStart,
    blockEnd,
  };
};
