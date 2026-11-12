const WINDOWS_DRIVE_ROOT = /^(?:\/\/\?\/)?[A-Za-z]:\/+$/u;
const WINDOWS_DRIVE_PREFIX = /^(?:\/\/\?\/)?[A-Za-z]:$/u;
const UNC_SHARE_ROOT = /^\/\/(?:[^/?][^/]*\/[^/]+|\?\/UNC\/[^/]+\/[^/]+)$/iu;

/**
 * Normalize a directory path for consistent comparison.
 *
 * Handles Windows-specific path quirks:
 * - Converts backslashes to forward slashes
 * - Uppercases lowercase Windows drive letters (e.g., "c:\\" → "C:\\")
 * - Trims trailing slashes, preserving Unix and Windows drive roots
 *
 * Returns null for non-string inputs, null/undefined, empty strings,
 * whitespace-only strings, and paths that consist only of slashes
 * (e.g. "\\", "\\\\", "///").
 *
 * The drive letter regex is anchored (^([a-z]):) and matches only a
 * single lowercase letter, so it never affects multi-character tokens
 * (e.g., "abc:def"), URLs, or Windows `\\?\` device paths.
 */
export const normalizePath = (value?: string | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const replaced = trimmed
    .replace(/\\/g, "/")
    .replace(/^([a-z]):/, (_, letter: string) => letter.toUpperCase() + ":");

  if (replaced === "/") return "/";
  // A Windows drive root is absolute; removing its slash turns it into a
  // drive-relative path whose meaning depends on that drive's current folder.
  if (WINDOWS_DRIVE_ROOT.test(replaced)) return replaced.replace(/\/+$/u, "/");
  const stripped = replaced.length > 1 ? replaced.replace(/\/+$/, "") : replaced;
  return stripped || null;
};

/** Lexical parent of an already-normalized directory; filesystem roots have none. */
export const getNormalizedParentDirectory = (directory: string): string | null => {
  if (directory === '/' || WINDOWS_DRIVE_ROOT.test(directory) || WINDOWS_DRIVE_PREFIX.test(directory) || UNC_SHARE_ROOT.test(directory)) return null;
  const separator = directory.lastIndexOf('/');
  if (separator < 0) return null;
  if (separator === 0) return '/';
  const parent = directory.slice(0, separator);
  return WINDOWS_DRIVE_PREFIX.test(parent) ? `${parent}/` : parent;
};

/**
 * The directory key every terminal surface must agree on: the terminal store's
 * map keys, the server `cwd` values grouped from a session listing, and the
 * sidebar indicators. Empty when the value is not a usable path.
 */
export const normalizeTerminalDirectory = (value: string): string => normalizePath(value) ?? '';
