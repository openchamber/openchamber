import type { SessionSidebarRow } from './sessionSidebarRowModel';

/**
 * Opening and closing a section, project, worktree, folder, multi-run or a
 * session's subsessions in the
 * sidebar. The rows are a flat virtual list, so there is no container to
 * animate: the rows the header shows or hides are revealed above a moving
 * boundary, and the rows after them slide with that boundary, as one block
 * changing height would.
 */

/** Whether a header row is open; null for rows that show or hide nothing, and while search forces every header open. */
const disclosureOpen = (row: SessionSidebarRow): boolean | null => {
  switch (row.kind) {
    case 'activity-header':
    case 'caption':
    case 'project-header':
    case 'group-header':
    case 'folder-header':
      return row.forceExpanded ? null : !row.collapsed;
    case 'run':
      return row.forceExpanded ? null : row.expanded;
    case 'session':
      return row.expanded === undefined || row.forceExpanded ? null : row.expanded;
    default:
      return null;
  }
};

type SessionSidebarDisclosure = {
  opened: boolean;
  /** The toggled header in the previous and in the next rows. */
  previousHeaderIndex: number;
  nextHeaderIndex: number;
  /**
   * The rows shown or hidden, `[blockStart, blockEnd)`: indexes into the next
   * rows when the header opened, into the previous rows when it closed.
   */
  blockStart: number;
  blockEnd: number;
};

/**
 * The one header the user just opened or closed between two row lists, with
 * the rows that appeared or went under it. Null when no header changed, when
 * several did at once (Collapse all, search), or when the change is not one
 * block of rows right under the header.
 */
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
