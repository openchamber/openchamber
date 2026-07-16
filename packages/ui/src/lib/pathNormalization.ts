/**
 * Normalize a directory path for consistent comparison.
 *
 * Handles Windows-specific path quirks:
 * - Converts backslashes to forward slashes
 * - Uppercases lowercase Windows drive letters (e.g., "c:\\" → "C:\\")
 * - Trims trailing slashes (except for the root "/")
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
  const stripped = replaced.length > 1 ? replaced.replace(/\/+$/, "") : replaced;
  return stripped || null;
};
