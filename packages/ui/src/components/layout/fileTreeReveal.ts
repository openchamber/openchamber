/**
 * "Scroll to the file the editor is showing" support for the context-panel
 * file tree (issue #3814).
 *
 * Opening a file already moves the tree's `selectedPath` (ContextPanel mirrors
 * the active file tab into it) and already expands the directories above the
 * row (the file editor's own `ensurePathVisible` writes the same store). What
 * never happened is the last step: scrolling that row into view. In a large
 * repository the highlighted row is simply somewhere outside the viewport, so
 * switching tabs tells the user nothing about where the file lives.
 *
 * The path check and the DOM lookup live here rather than in the component so
 * they can be tested without mounting the tree, and so the row attribute has a
 * single definition.
 */

/**
 * Attribute every file tree row renders (`SidebarFilesTree`), so a reveal can
 * find the row for a path without threading a ref through the memoized rows.
 */
const FILE_TREE_ROW_PATH_ATTRIBUTE = 'data-tree-path';

/**
 * The row to scroll to for `filePath`, or null when there is nothing to
 * reveal: no root, no file, a file outside the root, the root itself, or a
 * path that still carries `.`/`..` segments (which matches no row).
 *
 * Both arguments must already be normalized the way the tree normalizes paths
 * (forward slashes, no repeated or trailing separator); this function does no
 * normalizing of its own so it cannot disagree with the rendered rows on the
 * string identity of a path.
 */
export const resolveFileTreeRevealTarget = (
  root: string | null | undefined,
  filePath: string | null | undefined,
): string | null => {
  if (!root || !filePath) return null;

  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  if (!filePath.startsWith(rootPrefix)) return null;

  const relative = filePath.slice(rootPrefix.length);
  if (!relative) return null;

  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }

  return filePath;
};

/**
 * True while a reveal that has not been scrolled to yet is still the file the
 * editor is showing.
 *
 * A reveal can outlive its reason: the row may only appear much later (a slow
 * listing, or the user unhiding files), by which point the editor may be on
 * another tab. Scrolling then would move the tree to a file nobody is looking
 * at. Both paths must already be normalized.
 */
export const isPendingRevealCurrent = (
  pendingPath: string | null,
  activeFilePath: string | null,
): boolean => Boolean(pendingPath) && pendingPath === activeFilePath;

const escapeAttributeValue = (value: string): string => (
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
);

/** CSS selector matching the tree row for `path`. */
export const fileTreeRowSelector = (path: string): string => (
  `[${FILE_TREE_ROW_PATH_ATTRIBUTE}="${escapeAttributeValue(path)}"]`
);

/**
 * Scroll the row for `path` into view inside `container`, if it is rendered.
 *
 * `block: 'nearest'` is deliberate: a row that is already on screen must not
 * move, otherwise merely switching tabs would yank the tree around.
 *
 * Returns false when the row is not in the DOM yet — the caller retries on the
 * renders that could produce it.
 */
export const revealFileTreeRow = (
  container: ParentNode | null | undefined,
  path: string,
): boolean => {
  if (!container || !path) return false;

  const row = container.querySelector(fileTreeRowSelector(path));
  if (!row) return false;

  // SAFETY: the attribute is only rendered on the tree's row <button>s, so a
  // match is an HTMLElement; the assertion recovers the element type that
  // querySelector widens to Element.
  (row as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
};
