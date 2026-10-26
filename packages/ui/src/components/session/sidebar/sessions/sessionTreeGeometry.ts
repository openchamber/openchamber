import { fileTreeRowPaddingLeft } from '@/components/views/files/fileTreeRow';

// The session tree uses the file tree geometry with a 6px base instead of 8px:
// root session titles then start where the project header's label starts.
export const SESSION_TREE_BASE_PADDING_PX = 6;

export const sessionTreeRowPaddingLeft = (depth: number): string => fileTreeRowPaddingLeft(depth, SESSION_TREE_BASE_PADDING_PX);

/**
 * Where a two-line (detailed) row starts. It has no slot left of the title:
 * its state sits on the right and its chevron takes the place of the second
 * line's first icon, so its text starts 10px in at the first level.
 */
export const sessionDetailedRowPaddingLeft = (depth: number): string => `calc(${sessionTreeRowPaddingLeft(depth)} + 4px)`;

/** Where the text of a tree row starts: past the level's chevron slot (14px) and gap (6px). */
export const sessionTreeTextInset = (depth: number): string => `calc(${sessionTreeRowPaddingLeft(depth)} + 20px)`;

/**
 * One guide line a tree row draws: the line of `level`, which runs under the
 * slot of the row's ancestor one level up and frames that ancestor's
 * children. `end` marks its last child, where the line turns toward it.
 */
export type SessionTreeGuide = { level: number; end: boolean };

/**
 * The guides of each row in a run of tree rows, given their levels in display
 * order. A row's own level gets a guide that runs on, or ends at the row when
 * no later sibling follows; every shallower level whose line still has a
 * sibling to reach below runs through it. `null` breaks the run: a row that
 * is not part of a tree, such as a header or a Show more line.
 */
export const computeSessionTreeGuides = (levels: readonly (number | null)[]): (readonly SessionTreeGuide[] | null)[] => {
  const result: (readonly SessionTreeGuide[] | null)[] = new Array(levels.length).fill(null);
  // `siblingBelow[level]`: a later row sits at `level` before any shallower
  // row closes that level's line.
  let siblingBelow: boolean[] = [];
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    const level = levels[index];
    if (level === null || level === undefined) {
      siblingBelow = [];
      continue;
    }
    const guides: SessionTreeGuide[] = [];
    for (let line = 1; line < level; line += 1) {
      if (siblingBelow[line]) guides.push({ level: line, end: false });
    }
    if (level > 0) guides.push({ level, end: !siblingBelow[level] });
    if (guides.length > 0) result[index] = Object.freeze(guides);
    siblingBelow = siblingBelow.slice(0, level);
    siblingBelow[level] = true;
  }
  return result;
};
