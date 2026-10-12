import { fileTreeRowPaddingLeft } from '@/components/views/files/fileTreeRow';

// The session tree uses the file tree geometry with a 6px base instead of 8px:
// root session titles then start where the project header's label starts.
const SESSION_TREE_BASE_PADDING_PX = 6;

export const sessionTreeRowPaddingLeft = (depth: number): string => fileTreeRowPaddingLeft(depth, SESSION_TREE_BASE_PADDING_PX);

/** Where the text of a tree row starts: past the level's chevron slot (14px) and gap (6px). */
export const sessionTreeTextInset = (depth: number): string => `calc(${sessionTreeRowPaddingLeft(depth)} + 20px)`;
