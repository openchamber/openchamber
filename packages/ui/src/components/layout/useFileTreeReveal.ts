import React from 'react';

import { isPendingRevealCurrent, resolveFileTreeRevealTarget, revealFileTreeRow } from './fileTreeReveal';

export type FileTreeRevealParams = {
  /** Workspace root, normalized. */
  root: string | null;
  /** Normalized path of the file in the active editor tab, null for anything else. */
  activeFilePath: string | null;
  /** False while the tree column is hidden — nothing to scroll then. */
  enabled: boolean;
  /** True while the search filter replaces the tree with a flat result list. */
  searchActive: boolean;
  /** The element the rows live in; a reveal scrolls inside it. */
  listRef: React.RefObject<HTMLElement | null>;
  /** Listed rows per directory. A new identity means rows may have appeared. */
  childrenByDir: Record<string, readonly { path: string }[]>;
  /** Expanded directories. A new identity means rows may have appeared. */
  expandedPaths: readonly string[];
  /** Search hits on screen. Dropping back to 0 gives the tree rows back. */
  searchResultCount: number;
};

/**
 * Scroll the file tree to the file the editor beside it is showing (#3814).
 *
 * Only the scroll: the row is already selected (ContextPanel mirrors the
 * active file tab into `selectedPath`) and the directories above it are
 * already expanded and listed (the mounted file editor's `ensurePathVisible`
 * writes the same store). Both of those are invisible while the row sits
 * outside the viewport, which is the whole complaint — in a large repository
 * the open file cannot be found in the tree.
 *
 * Because the row may not exist yet when the tab changes, the reveal is kept
 * pending and retried on the renders that could produce it. It is dropped as
 * soon as the editor moves to another file.
 *
 * Lives outside the tree component so the sequencing — which is where the
 * behaviour actually is — can be tested without mounting the tree.
 */
export const useFileTreeReveal = ({
  root,
  activeFilePath,
  enabled,
  searchActive,
  listRef,
  childrenByDir,
  expandedPaths,
  searchResultCount,
}: FileTreeRevealParams): void => {
  // Last file revealed because the editor switched to it. Reveals are keyed on
  // the active file, not on the selection, so the tree stays where the user
  // left it until the editor moves on.
  const revealedFilePathRef = React.useRef<string | null>(null);
  // The row a reveal still has to scroll to. State rather than a ref: the row
  // is usually already rendered, and then no other render would re-run the
  // scroll effect.
  const [pendingRevealPath, setPendingRevealPath] = React.useState<string | null>(null);

  React.useEffect(() => {
    // A reveal is only meaningful for the root it was computed against.
    revealedFilePathRef.current = null;
    setPendingRevealPath(null);
  }, [root]);

  React.useEffect(() => {
    if (!enabled || searchActive || !root || !activeFilePath) return;

    const target = resolveFileTreeRevealTarget(root, activeFilePath);
    if (!target) return;
    if (revealedFilePathRef.current === target) return;

    revealedFilePathRef.current = target;
    setPendingRevealPath(target);
  }, [activeFilePath, enabled, root, searchActive]);

  React.useEffect(() => {
    if (!pendingRevealPath) return;

    // The editor has moved on (another tab, a non-file tab, a file outside
    // this root). A row that only renders now — a slow listing landed, or the
    // user unhid files — must not yank the tree to a file nobody is reading.
    if (!isPendingRevealCurrent(pendingRevealPath, activeFilePath)) {
      setPendingRevealPath(null);
      return;
    }

    if (revealFileTreeRow(listRef.current, pendingRevealPath)) {
      setPendingRevealPath(null);
    }
  }, [activeFilePath, childrenByDir, expandedPaths, listRef, pendingRevealPath, searchResultCount]);
};
