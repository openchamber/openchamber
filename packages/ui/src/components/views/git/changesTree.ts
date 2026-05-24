import type { GitStatus } from '@/lib/api/types';

export const TREE_INDENT_PX = 14;

export type ChangesTreeDirectoryNode = {
  id: string;
  path: string;
  name: string;
  children: Map<string, ChangesTreeDirectoryNode>;
  directFiles: GitStatus['files'];
  files: GitStatus['files'];
};

export type FlattenedTreeRow =
  | {
      key: string;
      kind: 'directory';
      depth: number;
      directory: ChangesTreeDirectoryNode;
    }
  | {
      key: string;
      kind: 'file';
      depth: number;
      file: GitStatus['files'][number];
    };

export const normalizePathForTree = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\/+/, '').trim();

const createDirectoryNode = (path: string, name: string): ChangesTreeDirectoryNode => ({
  id: `dir:${path}`,
  path,
  name,
  children: new Map(),
  directFiles: [],
  files: [],
});

export const buildChangesTree = (entries: GitStatus['files']): ChangesTreeDirectoryNode => {
  const root = createDirectoryNode('', '');

  for (const file of entries) {
    const normalized = normalizePathForTree(file.path);
    if (!normalized) {
      continue;
    }

    const segments = normalized.split('/').filter(Boolean);
    const directorySegments = segments.slice(0, -1);
    let current = root;
    current.files.push(file);

    if (directorySegments.length > 0) {
      let currentPath = '';
      for (const segment of directorySegments) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        const existing = current.children.get(segment);
        if (existing) {
          existing.files.push(file);
          current = existing;
          continue;
        }

        const created = createDirectoryNode(currentPath, segment);
        created.files.push(file);
        current.children.set(segment, created);
        current = created;
      }
    }

    current.directFiles.push(file);
  }

  return root;
};

export const flattenChangesTree = (
  root: ChangesTreeDirectoryNode,
  expandedDirectories: Set<string>,
): FlattenedTreeRow[] => {
  const rows: FlattenedTreeRow[] = [];

  const walk = (node: ChangesTreeDirectoryNode, depth: number) => {
    const directories = Array.from(node.children.values()).sort((a, b) => a.path.localeCompare(b.path));
    for (const directory of directories) {
      rows.push({
        key: directory.id,
        kind: 'directory',
        depth,
        directory,
      });

      if (expandedDirectories.has(directory.path)) {
        walk(directory, depth + 1);
      }
    }

    const directFiles = [...node.directFiles].sort((a, b) => a.path.localeCompare(b.path));

    for (const file of directFiles) {
      rows.push({
        key: `file:${normalizePathForTree(file.path)}`,
        kind: 'file',
        depth,
        file,
      });
    }
  };

  walk(root, 0);
  return rows;
};
