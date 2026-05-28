export type DiffSelectionSide = 'additions' | 'deletions';

export interface DiffLineRange {
  start: number;
  end: number;
}

export interface RevertHunkAction {
  path: string;
  oldRange: DiffLineRange | null;
  newRange: DiffLineRange | null;
  patch: string;
}

interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

const HUNK_HEADER_PATTERN = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

const parseCount = (value: string | undefined): number => {
  if (value === undefined) return 1;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
};

const parseHunkHeader = (line: string): HunkHeader | null => {
  const match = line.match(HUNK_HEADER_PATTERN);
  if (!match) return null;

  const oldStart = Number.parseInt(match[1], 10);
  const newStart = Number.parseInt(match[3], 10);
  if (!Number.isFinite(oldStart) || !Number.isFinite(newStart)) return null;

  return {
    oldStart,
    oldCount: parseCount(match[2]),
    newStart,
    newCount: parseCount(match[4]),
  };
};

const toRange = (start: number, count: number): DiffLineRange | null => {
  if (count <= 0) return null;
  return { start, end: start + count - 1 };
};

const rangesIntersect = (left: DiffLineRange, right: DiffLineRange): boolean =>
  left.start <= right.end && right.start <= left.end;

const normalizeSelectionRange = (selection: { start: number; end: number }): DiffLineRange => ({
  start: Math.min(selection.start, selection.end),
  end: Math.max(selection.start, selection.end),
});

export const buildRevertHunkActions = (path: string, patch: string): RevertHunkAction[] => {
  const trimmedPath = path.trim();
  if (!trimmedPath || !patch.trim()) return [];

  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const firstHunkIndex = lines.findIndex(line => line.startsWith('@@ '));
  if (firstHunkIndex < 0) return [];

  const fileHeader = lines.slice(0, firstHunkIndex);
  const actions: RevertHunkAction[] = [];
  let index = firstHunkIndex;

  while (index < lines.length) {
    const header = parseHunkHeader(lines[index]);
    if (!header) {
      index += 1;
      continue;
    }

    const hunkLines = [lines[index]];
    index += 1;

    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      hunkLines.push(lines[index]);
      index += 1;
    }

    const hunkPatch = [...fileHeader, ...hunkLines].join('\n');
    actions.push({
      path: trimmedPath,
      oldRange: toRange(header.oldStart, header.oldCount),
      newRange: toRange(header.newStart, header.newCount),
      patch: hunkPatch.endsWith('\n') ? hunkPatch : `${hunkPatch}\n`,
    });
  }

  return actions;
};

export const findRevertHunkActionForSelection = (
  actions: RevertHunkAction[],
  selection: { start: number; end: number; side?: DiffSelectionSide } | null,
): RevertHunkAction | null => {
  if (!selection) return null;

  const selectedRange = normalizeSelectionRange(selection);
  const side = selection.side ?? 'additions';

  for (const action of actions) {
    const actionRange = side === 'deletions' ? action.oldRange : action.newRange;
    if (actionRange && rangesIntersect(selectedRange, actionRange)) {
      return action;
    }
  }

  return null;
};
