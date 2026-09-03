/**
 * Normalize a directory path for consistent comparison.
 *
 * Handles Windows-specific path quirks:
 * - Converts backslashes to forward slashes
 * - Uppercases the Windows drive letter
 * - Trims trailing slashes (except for filesystem roots)
 *
 * Returns null for non-string inputs, null/undefined, empty strings,
 * whitespace-only strings, and paths that consist only of slashes
 * (e.g. "\\", "\\\\", "///").
 *
 * Drive-relative paths remain drive-relative (for example, "C:folder").
 * A drive root keeps its separator ("C:/"), so it is never collapsed to
 * "C:". The drive regex is anchored and matches one letter, so it never
 * affects multi-character tokens (e.g., "abc:def"), URLs, or Windows
 * `\\?\` device paths.
 */
export const normalizePath = (value?: string | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const replaced = trimmed.replace(/\\/g, "/");

  const driveMatch = /^([A-Za-z]):(.*)$/.exec(replaced);
  if (driveMatch) {
    const drive = driveMatch[1].toUpperCase();
    const suffix = driveMatch[2];
    if (!suffix) return `${drive}:`;
    if (/^\/+$/u.test(suffix)) return `${drive}:/`;
    return `${drive}:${suffix.replace(/\/+$/u, "")}`;
  }

  if (replaced === "/") return "/";
  const stripped = replaced.length > 1 ? replaced.replace(/\/+$/, "") : replaced;
  if (!stripped) return null;
  return stripped;
};

const WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:|\/\/)/;

/**
 * Canonicalize a normalized path for identity keys and comparisons.
 *
 * Display and authoritative paths must retain their component casing. Only
 * identity boundaries apply Windows' case-insensitive matching rules; POSIX
 * paths remain case-sensitive.
 */
export const canonicalizePathIdentity = (value?: string | null): string | null => {
  const normalized = normalizePath(value);
  if (!normalized) return null;
  return WINDOWS_PATH_PATTERN.test(normalized) ? normalized.toLowerCase() : normalized;
};
