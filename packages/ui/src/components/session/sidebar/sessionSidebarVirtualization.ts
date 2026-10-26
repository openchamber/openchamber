import type { SessionSidebarRow } from './sessionSidebarRowModel';
import { isWorktreeWorkGroup } from './works/sidebarWorks';

const INITIAL_ROW_LIMIT = 24;

export const getInitialSessionSidebarRowIndexes = (rowCount: number): number[] => (
  Array.from({ length: Math.min(rowCount, INITIAL_ROW_LIMIT) }, (_, index) => index)
);

export const mergeSessionSidebarVirtualIndexes = (
  visibleIndexes: readonly number[],
  pinnedIndexes: ReadonlySet<number>,
  rowCount: number,
): number[] => {
  const indexes = new Set(visibleIndexes);
  for (const index of pinnedIndexes) {
    if (index >= 0 && index < rowCount) indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
};

export const findFirstVisibleSessionSidebarRowIndex = (
  items: readonly { index: number; end: number }[],
  scrollOffset: number,
): number => items.find((item) => item.end > scrollOffset)?.index ?? 0;

const SECTION_SPACING_ESTIMATE = { 'pb-2': 8, 'pb-1.5': 6 } as const;

type SectionSpacing = keyof typeof SECTION_SPACING_ESTIMATE;

/**
 * Rows that share a kind and surface context render at the same height apart
 * from their trailing section gap, so one measured row tells the size of every
 * unmeasured one, with whatever gap it ends up having. The virtualizer
 * compensates the scroll position whenever a row above the viewport measures
 * differently from its estimate, and that write lands in the middle of the
 * user's scroll gesture.
 */
export const sessionSidebarRowSizeKey = (row: SessionSidebarRow): string => (
  `${row.kind}:${'renderContext' in row ? row.renderContext : ''}${'detailed' in row && row.detailed ? ':detailed' : ''}`
);

/**
 * The virtualizer's key for a row: its own key plus its trailing section gap.
 * A header's gap depends on the row after it, so closing or opening the header
 * changes its height without changing its key; under the plain key the
 * virtualizer would keep the old measured height until the resize observer
 * reported back, and the rows below would hop by the gap a frame later. A new
 * key takes the size estimate above, exact once a row like it was measured.
 */
export const sessionSidebarRowVirtualKey = (row: SessionSidebarRow, nextRow: SessionSidebarRow | undefined): string => (
  `${row.key}|${sectionSpacingAfter(row, nextRow) ?? ''}`
);

/**
 * A row's size: the measured height of a row like it (`sessionSidebarRowSizeKey`,
 * gap excluded) or the model estimate, plus its gap as measured or estimated.
 */
export const estimateSessionSidebarRowSize = (
  row: SessionSidebarRow,
  nextRow: SessionSidebarRow | undefined,
  measured: { height?: number; gapBySpacing?: ReadonlyMap<string, number> } = {},
): number => {
  const spacing = sectionSpacingAfter(row, nextRow);
  const gap = spacing ? measured.gapBySpacing?.get(spacing) ?? SECTION_SPACING_ESTIMATE[spacing] : 0;
  return (measured.height ?? row.estimateSize) + gap;
};

export const sectionSpacingAfter = (row: SessionSidebarRow, nextRow: SessionSidebarRow | undefined): SectionSpacing | undefined => {
  // Zones (Chats, Pinned, In work, the list by time) and projects are sections
  // of equal weight, so each opens with the same gap. A space or archive
  // header opens a smaller one inside its project, so its sessions read as a
  // group of their own. A worktree is a work row among session rows and opens none.
  const startsSection = nextRow?.kind === 'activity-header' || nextRow?.kind === 'project-header';
  if (startsSection) return 'pb-2';
  return nextRow?.kind === 'group-header' && !isWorktreeWorkGroup(nextRow.group) && row.kind !== 'project-header' ? 'pb-1.5' : undefined;
};
