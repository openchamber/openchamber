import type { GitStatus } from '@/lib/api/types';

type DirectoryNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  relativePath?: string;
};

export const areDirectoryNodesEqual = (left: readonly DirectoryNode[], right: readonly DirectoryNode[]): boolean => (
  left === right || (left.length === right.length && left.every((node, index) => {
    const other = right[index];
    return node.name === other.name && node.path === other.path && node.type === other.type
      && node.extension === other.extension && node.relativePath === other.relativePath;
  }))
);

type FileStatus = 'git-added' | 'git-deleted' | 'git-modified';
type FolderBadge = { modified: number; added: number };

export const buildFileTreeStatusIndex = (files: GitStatus['files']) => {
  const statusByPath = new Map<string, FileStatus | null>();
  const badgeByDir = new Map<string, FolderBadge>();
  for (const file of files) {
    if (!statusByPath.has(file.path)) {
      statusByPath.set(file.path, file.index === 'A' || file.working_dir === '?' ? 'git-added'
        : file.index === 'D' ? 'git-deleted'
        : file.index === 'M' || file.working_dir === 'M' ? 'git-modified' : null);
    }
    const modified = Number(file.index === 'M' || file.working_dir === 'M');
    const added = Number(file.index === 'A' || file.working_dir === '?');
    if (!modified && !added) continue;
    const ancestors = [''];
    for (let index = file.path.indexOf('/'); index !== -1; index = file.path.indexOf('/', index + 1)) {
      ancestors.push(file.path.slice(0, index));
    }
    for (const ancestor of ancestors) {
      const badge = badgeByDir.get(ancestor) ?? { modified: 0, added: 0 };
      badge.modified += modified;
      badge.added += added;
      badgeByDir.set(ancestor, badge);
    }
  }
  return { statusByPath, badgeByDir };
};
