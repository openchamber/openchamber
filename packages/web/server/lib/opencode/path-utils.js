
const TOOLCHAIN_SEGMENTS = [
  '/opt/homebrew/',
  '/opt/pkg/',
  '/opt/pmk/',
  '/snap/',
];

const TOOLCHAIN_BASENAMES = new Set([
  '.cargo',
  '.bun',
  '.nvm',
  '.pyenv',
  '.rbenv',
  '.sdkman',
  '.asdf',
  '.volta',
  '.fnm',
  '.local',
  '.opencode',
  'node_modules',
]);

/**
 * Returns true when `value` (a PATH string) contains at least one segment that
 * suggests the PATH was configured by the user or their session manager rather
 * than being a bare system default.
 *
 * @param {string} value  - The PATH string to inspect.
 * @param {string} home   - The user's home directory (os.homedir()).
 * @param {string} delim  - The PATH delimiter (':' on POSIX, ';' on Windows).
 */
export function pathLooksUserConfigured(value, home, delim) {
  if (typeof value !== 'string' || !value) {
    return false;
  }

  const normalizedHome = typeof home === 'string' ? home.replaceAll('\\', '/') : '';
  const homeWithSep = normalizedHome ? normalizedHome + '/' : '';

  return value.split(delim).some((segment) => {
    if (!segment) return false;
    const normalizedSegment = segment.replaceAll('\\', '/');

    if (normalizedHome && (normalizedSegment === normalizedHome || normalizedSegment.startsWith(homeWithSep))) {
      return true;
    }

    if (TOOLCHAIN_SEGMENTS.some((prefix) => normalizedSegment.startsWith(prefix))) {
      return true;
    }

    const parts = normalizedSegment.split('/').filter(Boolean);
    if (parts.some((part) => TOOLCHAIN_BASENAMES.has(part))) {
      return true;
    }

    return false;
  });
}

/**
 * Merges two PATH strings, deduplicating segments while preserving the order of
 * `primary` and appending any segments from `fallback` that are not already
 * present.
 *
 * @param {string} primary  - The preferred PATH (e.g. user-configured or login shell).
 * @param {string} fallback - The secondary PATH to fill gaps from.
 * @param {string} delim    - The PATH delimiter.
 */
export function mergePathValues(primary, fallback, delim) {
  const seen = new Set();
  const result = [];

  const addSegments = (value) => {
    if (typeof value !== 'string' || !value) return;
    for (const segment of value.split(delim)) {
      if (segment && !seen.has(segment)) {
        seen.add(segment);
        result.push(segment);
      }
    }
  };

  addSegments(primary);
  addSegments(fallback);

  return result.join(delim);
}
