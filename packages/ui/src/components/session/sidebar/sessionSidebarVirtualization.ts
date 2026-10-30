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

const SECTION_SPACING_ESTIMATE = { 'pb-5': 20, 'pb-3': 12, 'pb-1.5': 6, 'pb-0.5': 2 } as const;

type SectionSpacing = keyof typeof SECTION_SPACING_ESTIMATE;

/**
 * Fixed-height rows share measurements by kind and context. Detailed sessions
 * and drafts can omit their empty second line and keep their own measurement.
 * The virtualizer
 * compensates the scroll position whenever a row above the viewport measures
 * differently from its estimate, and that write lands in the middle of the
 * user's scroll gesture.
 */
export const sessionSidebarRowSizeKey = (row: SessionSidebarRow): string => {
  const context = 'renderContext' in row ? row.renderContext : '';
  const detailed = 'detailed' in row && row.detailed;
  const variableHeight = (row.kind === 'session' && (detailed || context === 'timeline-mixed'))
    || (row.kind === 'draft' && detailed);
  return `${row.kind}:${context}${detailed ? ':detailed' : ''}${variableHeight ? `:${row.key}` : ''}`;
};

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

/** The classes of a row's wrapper: its trailing gap, and the divider an open project section closes with. */
export const sectionWrapperClass = (row: SessionSidebarRow, nextRow: SessionSidebarRow | undefined): string => {
  const spacing = sectionSpacingAfter(row, nextRow) ?? '';
  // A line belongs to an open list. A closed section shows only its header, and
  // a reveal control draws its own line.
  const closedHeader = row.kind === 'project-header'
    || row.kind === 'activity-header'
    || row.kind === 'caption'
    || ((row.kind === 'group-header' || row.kind === 'folder-header') && row.collapsed);
  const closesProject = nextRow?.kind === 'project-header' && row.kind !== 'show-control' && !closedHeader;
  const isZoneRow = 'renderContext' in row && (row.renderContext === 'mixed-compact' || row.renderContext === 'timeline-mixed' || row.renderContext === 'tree-chat');
  const isTimelineStatus = row.kind === 'status' && row.flat === true;
  const rowWorktree = row.kind === 'session'
    ? Boolean(row.node.worktree)
    // A run is a project row when its root sits at the project root; a lane's
    // own worktree does not make the run a worktree row.
    : row.kind === 'run'
      ? row.depth > 0
      : row.kind === 'group-header' && isGroupWork(row.group);
  const deepWithoutContext = !('renderContext' in row) && 'depth' in row && (row.depth ?? 0) > 0;
  const inWorktree = rowWorktree || deepWithoutContext;
  const dividerLevel = isZoneRow || isTimelineStatus ? 'section' : inWorktree ? 'worktree' : 'project';
  const dividerClass = closesProject ? `oc-sidebar-project-divider oc-sidebar-project-divider--${dividerLevel}` : '';
  return [spacing, dividerClass].filter(Boolean).join(' ');
};

export const sectionSpacingAfter = (row: SessionSidebarRow, nextRow: SessionSidebarRow | undefined): SectionSpacing | undefined => {
  // A project opens with the widest gap, whether it follows rows or another
  // project: the gap holds the faded hairline that closes the section above
  // (`oc-sidebar-project-divider`). A flush hairline striped a run of collapsed
  // projects and was dropped. A zone opens with the widest gap, so its bare
  // label reads as a caption of what follows. A space or archive header opens a
  // smaller one inside its project, so its sessions read as a group of their
  // own. A worktree is a work row among session rows and opens none.
  if (nextRow?.kind === 'project-header') {
    if (row.kind === 'caption') return undefined;
    if (row.kind === 'show-control') return 'pb-0.5';
    return 'pb-3';
  }
  if (nextRow?.kind === 'activity-header' || nextRow?.kind === 'caption') {
    return row.kind === 'show-control' ? 'pb-3' : 'pb-5';
  }
  return nextRow?.kind === 'group-header' && !isGroupWork(nextRow.group) && row.kind !== 'project-header' ? 'pb-1.5' : undefined;
};
