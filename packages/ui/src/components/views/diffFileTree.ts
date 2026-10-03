import { buildChangesTree, compactDirectory, type ChangesTreeDirectoryNode } from './git/changesTree';

type DiffTreeRow<F extends { path: string }> =
  | { kind: 'directory'; key: string; depth: number; path: string; label: string; fileCount: number; expanded: boolean }
  | { kind: 'file'; key: string; depth: number; name: string; file: F };

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Flattens changed files into visible tree rows. A directory whose only
 * content is one subdirectory merges into it (`packages/ui/src`), so deep
 * monorepo paths don't cost one row per segment. Directories are expanded
 * unless their (merged) path is in `collapsed`.
 */
export const buildDiffTreeRows = <F extends { path: string }>(
  files: F[],
  collapsed: ReadonlySet<string>,
): DiffTreeRow<F>[] => {
  const rows: DiffTreeRow<F>[] = [];

  const walk = (node: ChangesTreeDirectoryNode<F>, depth: number) => {
    const directories = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
    for (const directory of directories) {
      const { node: target, label } = compactDirectory(directory);
      const expanded = !collapsed.has(target.path);
      rows.push({ kind: 'directory', key: `dir:${target.path}`, depth, path: target.path, label, fileCount: target.files.length, expanded });
      if (expanded) {
        walk(target, depth + 1);
      }
    }

    const directFiles = [...node.directFiles].sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
    for (const file of directFiles) {
      rows.push({ kind: 'file', key: `file:${file.path}`, depth, name: baseName(file.path), file });
    }
  };

  walk(buildChangesTree(files), 0);
  return rows;
};
