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

const SECTION_SPACING_ESTIMATE = { 'pb-4': 16, 'pb-3': 12, 'pb-1.5': 6, 'pb-0.5': 2 } as const;

type SectionSpacing = keyof typeof SECTION_SPACING_ESTIMATE;

export const sessionSidebarRowSizeKey = (row: SessionSidebarRow): string => {
  if (row.kind === 'search-result') return `search:${row.key}:${Boolean(row.result.excerpt)}`;
  const context = 'renderContext' in row ? row.renderContext : '';
  const detailed = 'detailed' in row && row.detailed;
  const variableHeight = (row.kind === 'session' && (detailed || context === 'timeline-mixed'))
    || (row.kind === 'draft' && detailed);
  return `${row.kind}:${context}${detailed ? ':detailed' : ''}${variableHeight ? `:${row.key}` : ''}`;
};

export const sessionSidebarRowVirtualKey = (row: SessionSidebarRow, nextRow: SessionSidebarRow | undefined): string => (
  `${row.key}|${sectionSpacingAfter(row, nextRow) ?? ''}|${sessionSidebarRowSizeKey(row)}`
);

const rowUserState = (row: SessionSidebarRow): string | undefined => {
  switch (row.kind) {
    case 'group-header':
    case 'folder-header':
      return row.empty ? undefined : String(row.collapsed);
    case 'activity-header':
    case 'project-header':
    case 'caption':
      return String(row.collapsed);
    case 'session':
      return row.expanded === undefined ? undefined : String(row.expanded);
    case 'run':
      return String(row.expanded);
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

type SessionSidebarScrollAnchor = { key: string; fraction: number; offset: number };

const groupsInPlace = (
  rows: readonly SessionSidebarRow[],
  groups: readonly (readonly number[])[],
  nextIndexByKey: ReadonlyMap<string, number>,
): number[] => {
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

const sectionsInPlace = (
  rows: readonly SessionSidebarRow[],
  sections: readonly (readonly number[])[],
  nextIndexByKey: ReadonlyMap<string, number>,
  shownSection: number,
): number[] => {
  const positions = sections.map((members) => members.map((index) => nextIndexByKey.get(rows[index].key)).find((next) => next !== undefined));
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

export const resolveSessionSidebarScrollAnchor = (
  anchor: SessionSidebarScrollAnchor,
  nextIndexByKey: ReadonlyMap<string, number>,
  measurements: readonly { start: number; size: number }[],
): number | null => {
  const index = nextIndexByKey.get(anchor.key);
  const measured = index === undefined ? undefined : measurements[index];
  return measured ? measured.start + anchor.fraction * measured.size + anchor.offset : null;
};

export const estimateSessionSidebarRowSize = (
  row: SessionSidebarRow,
  nextRow: SessionSidebarRow | undefined,
  measured: { height?: number; gapBySpacing?: ReadonlyMap<string, number> } = {},
): number => {
  const spacing = sectionSpacingAfter(row, nextRow);
  const gap = spacing ? measured.gapBySpacing?.get(spacing) ?? SECTION_SPACING_ESTIMATE[spacing] : 0;
  return (measured.height ?? row.estimateSize) + gap;
};

const PROJECT_DIVIDER_CLASS = "after:pointer-events-none after:absolute after:start-1.5 after:end-1.5 after:bottom-[5.5px] after:h-px after:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] after:content-['']";

export const sectionWrapperClass = (row: SessionSidebarRow, nextRow: SessionSidebarRow | undefined, projectDivider = true): string => {
  const spacing = sectionSpacingAfter(row, nextRow);
  if (projectDivider && spacing === 'pb-3' && nextRow?.kind === 'project-header') return `${spacing} ${PROJECT_DIVIDER_CLASS}`;
  return spacing ?? '';
};

export const sectionSpacingAfter = (row: SessionSidebarRow, nextRow: SessionSidebarRow | undefined): SectionSpacing | undefined => {
  if (nextRow?.kind === 'project-header') {
    if (row.kind === 'caption') return undefined;
    return row.kind === 'project-header' ? 'pb-0.5' : 'pb-3';
  }
  if (nextRow?.kind === 'activity-header' || nextRow?.kind === 'caption' || nextRow?.kind === 'search-archived-caption') return 'pb-4';
  return nextRow?.kind === 'group-header' && !isGroupWork(nextRow.group) && row.kind !== 'project-header' ? 'pb-1.5' : undefined;
};
