/** A drive path, a UNC share, or a POSIX absolute path — anything already rooted. */
export const isAbsolutePath = (value: string): boolean => /^([a-zA-Z]:[\\/]|[\\/][\\/]|\/)/.test(value);

/**
 * Whether Enter should add the path in the field rather than move around the listing.
 *
 * Enter is the key someone presses after typing or pasting a path, and it should mean
 * what they wrote. It becomes a navigation key only for a row they actually reached for,
 * with the arrow keys or the pointer — otherwise the default highlight decides, and the
 * default is the parent link, so a complete path was answered by going up a level.
 *
 * It never creates. A path that is not there is reached by typing a partial name, where
 * Enter should open the match being filtered towards; creating stays with the button that
 * says so.
 */
export const canConfirmPathOnEnter = (state: {
  rowChosen: boolean;
  targetPath: string;
  wouldCreate: boolean;
  isAlreadyAdded: boolean;
  isBusy: boolean;
}): boolean => (
  !state.rowChosen
  && Boolean(state.targetPath)
  && !state.wouldCreate
  && !state.isAlreadyAdded
  && !state.isBusy
);

const hasTrailingSeparator = (value: string): boolean => value.endsWith('/');

/** Adds the trailing separator that marks a value as a directory to browse into. */
export const ensureBrowseDirectoryPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || hasTrailingSeparator(trimmed)) return trimmed;
  return `${trimmed}/`;
};

/**
 * Where the field should point after a row in the listing is opened.
 *
 * The row carries the path the listing gave it, and that is what is used. Building one
 * instead by grafting the row's bare name onto whatever the field currently holds goes
 * wrong the moment the two have drifted apart, and they do: the listing is fetched
 * asynchronously, so pasting a path and pressing Enter straight away acts on rows that
 * still describe the previous directory. That appended a sibling of the old directory to
 * the new path, producing somewhere that does not exist — which the dialog then offers to
 * create, because that is the honest thing to do with a path that is not there.
 */
export const browseTargetForRow = (row: { name: string; path: string | null }): string | null => {
  // A row without a path is the parent link of a listing that has no parent; there is
  // nowhere to go, and deriving somewhere from the field would be the same defect again.
  if (!row.path) return null;
  return ensureBrowseDirectoryPath(row.path);
};

/** Resolves what the path field shows into a path the host can open. */
export const displayPathToAbsolutePath = (value: string, homeDirectory: string): string => {
  const trimmed = value.trim();
  if (trimmed === '~') return homeDirectory;
  if (trimmed.startsWith('~/')) {
    // The field opens at `~/` with the caret after it, so pasting an absolute path lands
    // behind the tilde and would otherwise be joined onto the home directory. The result
    // is a path nobody meant, and because it does not exist the dialog offers to create
    // it — which is how empty directories end up in a home folder. A rooted remainder
    // replaces the tilde instead of hanging off it.
    const remainder = trimmed.slice(2);
    if (isAbsolutePath(remainder)) return remainder;
    return `${homeDirectory}${trimmed.slice(1)}`;
  }
  return trimmed;
};
