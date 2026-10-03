import type { GitStatus } from '@/lib/api/types';

export const TREE_INDENT_PX = 14;

type TreeFile = { path: string };

export type ChangesTreeDirectoryNode<F extends TreeFile = GitStatus['files'][number]> = {
  id: string;
  path: string;
  name: string;
  children: Map<string, ChangesTreeDirectoryNode<F>>;
  directFiles: F[];
  files: F[];
};

export type FlattenedTreeRow<F extends TreeFile = GitStatus['files'][number]> =
  | {
      key: string;
      kind: 'directory';
      depth: number;
      /** Display label; merged single-child chains read `ui/src`. */
      label: string;
      directory: ChangesTreeDirectoryNode<F>;
    }
  | {
      key: string;
      kind: 'file';
      depth: number;
      file: F;
    };

const normalizePathForTree = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\/+/, '').trim();

const createDirectoryNode = <F extends TreeFile>(path: string, name: string): ChangesTreeDirectoryNode<F> => ({
  id: `dir:${path}`,
  path,
  name,
  children: new Map(),
  directFiles: [],
  files: [],
});

export const buildChangesTree = <F extends TreeFile>(entries: F[]): ChangesTreeDirectoryNode<F> => {
  const root = createDirectoryNode<F>('', '');

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

        const created = createDirectoryNode<F>(currentPath, segment);
        created.files.push(file);
        current.children.set(segment, created);
        current = created;
      }
    }

    current.directFiles.push(file);
  }

  return root;
};

/**
 * Follows a chain of directories that hold nothing but one subdirectory, so
 * `packages/ui/src` renders as one row instead of three. The returned node is
 * the deepest one; its path keys expansion state.
 */
export const compactDirectory = <F extends TreeFile>(
  directory: ChangesTreeDirectoryNode<F>,
): { node: ChangesTreeDirectoryNode<F>; label: string } => {
  let node = directory;
  let label = directory.name;
  while (node.directFiles.length === 0 && node.children.size === 1) {
    const [only] = node.children.values();
    node = only;
    label = `${label}/${only.name}`;
  }
  return { node, label };
};

export const flattenChangesTree = <F extends TreeFile>(
  root: ChangesTreeDirectoryNode<F>,
  expandedDirectories: Set<string>,
): FlattenedTreeRow<F>[] => {
  const rows: FlattenedTreeRow<F>[] = [];

  const walk = (node: ChangesTreeDirectoryNode<F>, depth: number) => {
    const directories = Array.from(node.children.values()).sort((a, b) => a.path.localeCompare(b.path));
    for (const child of directories) {
      const { node: directory, label } = compactDirectory(child);
      rows.push({
        key: directory.id,
        kind: 'directory',
        depth,
        label,
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
