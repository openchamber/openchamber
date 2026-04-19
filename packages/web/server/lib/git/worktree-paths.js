import path from 'path';

const WORKTREE_NAME_MAX_LENGTH = 24;
const PROJECT_ID_SEGMENT_LENGTH = 12;

export const shortProjectId = (value) => {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!normalized) {
    return 'default';
  }
  return normalized.slice(0, PROJECT_ID_SEGMENT_LENGTH);
};

export const buildWorktreeRoot = (dataRoot, projectId) => path.join(dataRoot, 'worktree', shortProjectId(projectId));

export const clampWorktreeLeafName = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.slice(0, WORKTREE_NAME_MAX_LENGTH).replace(/-+$/g, '');
};

export const worktreeDir = (worktreeRoot, leafName) => path.join(worktreeRoot, clampWorktreeLeafName(leafName));
