
type FileTreeRowNode = {
  path: string;
  type: 'file' | 'directory';
};

export type FileTreeRow<Node extends FileTreeRowNode> =
  | { kind: 'node'; key: string; node: Node; depth: number; isExpanded: boolean }
  | { kind: 'error'; key: string; directory: string; depth: number; message: string };

export const buildFileTreeRows = <Node extends FileTreeRowNode>({
  root,
  childrenByDir,
  expandedPaths,
  loadErrorsByDir,
}: {
  root: string;
  childrenByDir: Readonly<Record<string, readonly Node[]>>;
  expandedPaths: ReadonlySet<string>;
  loadErrorsByDir: Readonly<Record<string, string>>;
}): FileTreeRow<Node>[] => {
  const rows: FileTreeRow<Node>[] = [];
  const walk = (directory: string, depth: number) => {
    for (const node of childrenByDir[directory] ?? []) {
      const isExpanded = node.type === 'directory' && expandedPaths.has(node.path);
      rows.push({ kind: 'node', key: node.path, node, depth, isExpanded });
      if (!isExpanded) continue;
      const message = loadErrorsByDir[node.path];
      if (message) rows.push({ kind: 'error', key: `error:${node.path}`, directory: node.path, depth: depth + 1, message });
      walk(node.path, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
};

export const withPinnedRowIndexes = (range: readonly number[], pinned: readonly number[], count: number): number[] => {
  const extra = pinned.filter((index) => index >= 0 && index < count && !range.includes(index));
  if (extra.length === 0) return [...range];
  return [...range, ...extra].sort((a, b) => a - b);
};
