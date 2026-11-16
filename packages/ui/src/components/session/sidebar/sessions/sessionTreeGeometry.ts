import { fileTreeRowPaddingLeft } from '@/components/views/files/fileTreeRow';

export const SESSION_TREE_BASE_PADDING_PX = 6;

export const sessionTreeRowPaddingLeft = (depth: number): string => fileTreeRowPaddingLeft(depth, SESSION_TREE_BASE_PADDING_PX);

export const sessionDetailedRowPaddingLeft = (depth: number): string => `calc(${sessionTreeRowPaddingLeft(depth)} + 4px)`;

export const sessionTreeTextInset = (depth: number): string => `calc(${sessionTreeRowPaddingLeft(depth)} + 20px)`;

export type SessionTreeGuide = { level: number; end: boolean };

export const computeSessionTreeGuides = (levels: readonly (number | null)[]): (readonly SessionTreeGuide[] | null)[] => {
  const result: (readonly SessionTreeGuide[] | null)[] = new Array(levels.length).fill(null);
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
