import type { SessionSidebarRow } from './sessionSidebarRowModel';
import { isGroupWork } from './works/sidebarWorks';

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

// A hairline in the middle of the gap before a project: projects read apart
// from each other and from the zones above them. It is drawn in the gap, so it
// adds no height and the size estimates above hold (maintainer, 2026-10-26).
// Plain `--border` nearly vanished on the light themes, so the line mixes in
// a little of the text colour and stays in each theme's tone; at 22% it drew
// the eye more than the headers it separates.
const PROJECT_DIVIDER_CLASS = 'relative after:pointer-events-none after:absolute after:inset-x-2 after:bottom-1 after:h-px after:bg-[color-mix(in_oklab,var(--border),var(--foreground)_10%)]';

/** The classes of a row's wrapper: its trailing gap, and the divider before a project. */
export const sectionWrapperClass = (row: SessionSidebarRow, nextRow: SessionSidebarRow | undefined): string => {
  const spacing = sectionSpacingAfter(row, nextRow);
  if (!spacing) return '';
  return nextRow?.kind === 'project-header' ? `${spacing} ${PROJECT_DIVIDER_CLASS}` : spacing;
};

export const sectionSpacingAfter = (row: SessionSidebarRow, nextRow: SessionSidebarRow | undefined): SectionSpacing | undefined => {
  // Zones (Chats, Pinned, In work, the list by time) and projects are sections
  // of equal weight, so each opens with the same gap. A space or archive
  // header opens a smaller one inside its project, so its sessions read as a
  // group of their own. A worktree is a work row among session rows and opens none.
  const startsSection = nextRow?.kind === 'activity-header' || nextRow?.kind === 'project-header';
  if (startsSection) return 'pb-2';
  return nextRow?.kind === 'group-header' && !isGroupWork(nextRow.group) && row.kind !== 'project-header' ? 'pb-1.5' : undefined;
};
