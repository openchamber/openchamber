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
 * The virtualizer's key for a row: its own key plus its trailing section gap
 * and its size key. A header's gap depends on the row after it, so closing or
 * opening the header changes its height without changing its key; under the
 * plain key the virtualizer would keep the old measured height until the
 * resize observer reported back, and the rows below would hop by the gap a
 * frame later. A row that turns between one and two lines (Detailed rows) is
 * the same: the virtualizer drops measurements of rows that are not mounted
 * only when their key goes, so rows near the last viewport kept the old
 * mode's height. A new key takes the size estimate above, exact once a row
 * like it was measured.
 */
export const sessionSidebarRowVirtualKey = (row: SessionSidebarRow, nextRow: SessionSidebarRow | undefined): string => (
  `${row.key}|${sectionSpacingAfter(row, nextRow) ?? ''}|${sessionSidebarRowSizeKey(row)}`
);

// What the user set on a row: a header open or closed, subsessions shown, how
// many sessions Show more asked for, and search forcing everything open.
// Undefined where the row offers nothing to set: a session without
// subsessions, an empty group or folder (always open). Sessions coming and
// going change that, not the user.
const rowUserState = (row: SessionSidebarRow): string | undefined => {
  switch (row.kind) {
    case 'group-header':
    case 'folder-header':
      return row.empty ? undefined : `${row.collapsed}:${row.forceExpanded}`;
    case 'activity-header':
    case 'project-header':
    case 'caption':
      return `${row.collapsed}:${row.forceExpanded}`;
    case 'session':
      return row.expanded === undefined ? undefined : `${row.expanded}:${row.forceExpanded === true}`;
    case 'run':
      return `${row.expanded}:${row.forceExpanded}`;
    case 'show-control':
      return String(row.requestedCount);
    default:
      return undefined;
  }
};

type SessionSidebarRowList = {
  rows: readonly SessionSidebarRow[];
  rowIndexByKey: ReadonlyMap<string, number>;
  search: boolean;
};

/**
 * Whether the user changed the list rather than the sessions in it: a header
 * opened or closed, Show more or less, subsessions shown or hidden, a search.
 * The list then behaves as the user's action makes it (a header's motion, new
 * rows where the control was); for any other change, sessions arriving,
 * leaving or moving and rows changing height, it keeps the row the user sees
 * in place (`SessionSidebarRows`). Projects and sections dragged into
 * another order are the user's too, but the rows cannot tell them from
 * projects sorted by recent activity moving on their own: the drag holds the
 * row it dropped instead (`heldRowRef`).
 */
export const isSessionSidebarUserChange = (previous: SessionSidebarRowList, next: SessionSidebarRowList): boolean => {
  if (previous.search || next.search) return true;
  for (const row of previous.rows) {
    const index = next.rowIndexByKey.get(row.key);
    if (index === undefined) continue;
    const before = rowUserState(row);
    const after = rowUserState(next.rows[index]);
    if (before !== undefined && after !== undefined && before !== after) return true;
  }
  return false;
};

/**
 * A row the user sees and where it sits: the row under the line `fraction` of
 * its height in, or a row below the line `offset` pixels under it.
 */
type SessionSidebarScrollAnchor = { key: string; fraction: number; offset: number };

/**
 * The groups that kept their order: the longest run of groups, in their old
 * order, whose new positions also increase, so whatever is left out is the
 * fewest groups that moved. A group stands at its first row still listed.
 */
const groupsInPlace = (
  rows: readonly SessionSidebarRow[],
  groups: readonly (readonly number[])[],
  nextIndexByKey: ReadonlyMap<string, number>,
): number[] => {
  // tails[length - 1]: the group ending the best run of that length so far.
  const tails: number[] = [];
  const tailPositions: number[] = [];
  const previous = new Map<number, number>();
  groups.forEach((members, group) => {
    const position = members.map((index) => nextIndexByKey.get(rows[index].key)).find((next) => next !== undefined);
    if (position === undefined) return;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tailPositions[middle] < position) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous.set(group, tails[low - 1]);
    tails[low] = group;
    tailPositions[low] = position;
  });
  const kept: number[] = [];
  for (let group = tails.at(-1); group !== undefined; group = previous.get(group)) kept.push(group);
  return kept.reverse();
};

const isSectionHeader = (row: SessionSidebarRow): boolean => (
  row.kind === 'project-header' || row.kind === 'activity-header' || row.kind === 'caption'
);

/**
 * The sections that kept their order, as `groupsInPlace` does, except that a
 * tie goes to the section the user is looking at: a project that went above
 * the one on screen and the one on screen going below it are the same change
 * in order. A few dozen sections at most, so the quadratic search is cheap.
 */
const sectionsInPlace = (
  rows: readonly SessionSidebarRow[],
  sections: readonly (readonly number[])[],
  nextIndexByKey: ReadonlyMap<string, number>,
  shownSection: number,
): number[] => {
  const positions = sections.map((members) => members.map((index) => nextIndexByKey.get(rows[index].key)).find((next) => next !== undefined));
  // Less than one section, so it only breaks ties.
  const weight = (section: number) => (section === shownSection ? 1.5 : 1);
  const best: number[] = [];
  const previous: (number | undefined)[] = [];
  let end: number | undefined;
  sections.forEach((_, section) => {
    const position = positions[section];
    if (position === undefined) return;
    best[section] = weight(section);
    for (let before = 0; before < section; before += 1) {
      const earlier = positions[before];
      if (earlier !== undefined && earlier < position && best[before] + weight(section) > best[section]) {
        best[section] = best[before] + weight(section);
        previous[section] = before;
      }
    }
    if (end === undefined || best[section] > best[end]) end = section;
  });
  const kept: number[] = [];
  for (let section = end; section !== undefined; section = previous[section]) kept.push(section);
  return kept.reverse();
};

/**
 * The rows that kept their place, in two steps. Sections first: a project or
 * a zone with everything under its header, so a project sorted by recent
 * activity that went to the top counts once, however many sessions it lists.
 * Then works inside the sections that stayed: a session or a run with the
 * rows open under it, and every other row on its own, so a session that
 * became active and went to the top of its project counts once too, however
 * many subsessions it has open. Counted by rows, a long open tree or a large
 * project outvoted what it jumped over. `shownIndex` is the old row under the
 * line. Returns old row indexes.
 */
const rowsInPlace = (rows: readonly SessionSidebarRow[], nextIndexByKey: ReadonlyMap<string, number>, shownIndex: number): Set<number> => {
  const sections: number[][] = [];
  let shownSection = -1;
  rows.forEach((row, index) => {
    if (isSectionHeader(row) || sections.length === 0) sections.push([]);
    sections[sections.length - 1].push(index);
    if (index === shownIndex) shownSection = sections.length - 1;
  });
  const works: number[][] = [];
  for (const section of sectionsInPlace(rows, sections, nextIndexByKey, shownSection)) {
    let rootDepth = -1;
    for (const index of sections[section]) {
      const row = rows[index];
      const nested = row.kind === 'session' || row.kind === 'run';
      if (nested && rootDepth >= 0 && row.depth > rootDepth) {
        works[works.length - 1].push(index);
        continue;
      }
      works.push([index]);
      rootDepth = nested ? row.depth : -1;
    }
  }
  const kept = new Set<number>();
  for (const work of groupsInPlace(rows, works, nextIndexByKey)) {
    for (const index of works[work]) if (nextIndexByKey.has(rows[index].key)) kept.add(index);
  }
  return kept;
};

/**
 * The row to keep in place while the rows around it change: the first row on
 * screen that kept its place in the list (`rowsInPlace`), the row under the
 * line unless it moved. `items` are the previous layout's rows in index order.
 */
export const findSessionSidebarScrollAnchor = (
  rows: readonly SessionSidebarRow[],
  items: readonly { index: number; start: number; end: number }[],
  line: number,
  viewportEnd: number,
  nextIndexByKey: ReadonlyMap<string, number>,
): SessionSidebarScrollAnchor | null => {
  const kept = rowsInPlace(rows, nextIndexByKey, items.find((candidate) => candidate.end > line)?.index ?? -1);
  const item = items.find((candidate) => candidate.end > line && candidate.start < viewportEnd && kept.has(candidate.index));
  const row = item ? rows[item.index] : undefined;
  if (!item || !row) return null;
  if (item.start > line) return { key: row.key, fraction: 0, offset: line - item.start };
  const size = item.end - item.start;
  return { key: row.key, fraction: size > 0 ? (line - item.start) / size : 0, offset: 0 };
};

/** Where the line now crosses the list: the anchor row's new start, plus the same share of its new height or the same distance. */
export const resolveSessionSidebarScrollAnchor = (
  anchor: SessionSidebarScrollAnchor,
  nextIndexByKey: ReadonlyMap<string, number>,
  measurements: readonly { start: number; size: number }[],
): number | null => {
  const index = nextIndexByKey.get(anchor.key);
  const measured = index === undefined ? undefined : measurements[index];
  return measured ? measured.start + anchor.fraction * measured.size + anchor.offset : null;
};

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

/** The classes of a row's wrapper: its trailing gap. */
export const sectionWrapperClass = (row: SessionSidebarRow, nextRow: SessionSidebarRow | undefined): string => (
  sectionSpacingAfter(row, nextRow) ?? ''
);

export const sectionSpacingAfter = (row: SessionSidebarRow, nextRow: SessionSidebarRow | undefined): SectionSpacing | undefined => {
  // Projects are set apart by space alone, with no line between them. A
  // project after rows (an open project, a zone) opens with the widest gap;
  // one right after a collapsed project keeps a narrow one, so a run of
  // collapsed projects reads as a list. A zone opens with the widest gap, so its
  // bare label reads as a caption of what follows. A
  // space or archive header opens a smaller one inside its project, so its
  // sessions read as a group of their own. A worktree is a work row among
  // session rows and opens none.
  if (nextRow?.kind === 'project-header') {
    if (row.kind === 'caption') return undefined;
    return row.kind === 'project-header' ? 'pb-0.5' : 'pb-3';
  }
  if (nextRow?.kind === 'activity-header' || nextRow?.kind === 'caption') return 'pb-5';
  return nextRow?.kind === 'group-header' && !isGroupWork(nextRow.group) && row.kind !== 'project-header' ? 'pb-1.5' : undefined;
};
