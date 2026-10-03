import type { SessionSidebarRow } from './sessionSidebarRowModel';

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

export const sectionSpacingAfter = (row: SessionSidebarRow, nextRow: SessionSidebarRow | undefined): string | undefined => {
  // The zones above the projects (Chats, In work, Recent) end with a wider
  // gap, whichever of them happens to be the last one shown.
  const endsZones = row.key.startsWith('activity:') && nextRow !== undefined && !nextRow.key.startsWith('activity:');
  if (endsZones && (nextRow.kind === 'project-header' || nextRow.kind === 'group-header')) {
    return 'pb-6';
  }
  const startsSection = nextRow?.kind === 'activity-header'
    || nextRow?.kind === 'project-header'
    || (nextRow?.kind === 'group-header' && row.kind !== 'project-header');
  return startsSection ? 'pb-2' : undefined;
};
