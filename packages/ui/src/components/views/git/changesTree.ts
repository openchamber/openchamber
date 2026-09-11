import type { GitStatus } from '@/lib/api/types';

export const TREE_INDENT_PX = 14;

type TreePathEntry = {
  path: string;
};

type GitStatusFile = GitStatus['files'][number];

export type ChangesTreeDirectoryNode<TEntry extends TreePathEntry = GitStatusFile> = {
  id: string;
  path: string;
  name: string;
  children: Map<string, ChangesTreeDirectoryNode<TEntry>>;
  directFiles: TEntry[];
  files: TEntry[];
};

export type FlattenedTreeRow<TEntry extends TreePathEntry = GitStatusFile> =
  | {
      key: string;
      kind: 'directory';
      depth: number;
      directory: ChangesTreeDirectoryNode<TEntry>;
    }
  | {
      key: string;
      kind: 'file';
      depth: number;
      file: TEntry;
    };

const normalizePathForTree = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\/+/, '').trim();

const createDirectoryNode = <TEntry extends TreePathEntry>(path: string, name: string): ChangesTreeDirectoryNode<TEntry> => ({
  id: `dir:${path}`,
  path,
  name,
  children: new Map(),
  directFiles: [],
  files: [],
});

export const buildChangesTree = <TEntry extends TreePathEntry>(entries: TEntry[]): ChangesTreeDirectoryNode<TEntry> => {
  const root = createDirectoryNode<TEntry>('', '');

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

        const created = createDirectoryNode<TEntry>(currentPath, segment);
        created.files.push(file);
        current.children.set(segment, created);
        current = created;
      }
    }

    current.directFiles.push(file);
  }

  return root;
};

export const flattenChangesTree = <TEntry extends TreePathEntry>(
  root: ChangesTreeDirectoryNode<TEntry>,
  expandedDirectories: Set<string>,
): FlattenedTreeRow<TEntry>[] => {
  const rows: FlattenedTreeRow<TEntry>[] = [];

  const walk = (node: ChangesTreeDirectoryNode<TEntry>, depth: number) => {
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
