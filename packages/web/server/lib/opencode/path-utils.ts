import { isString } from '../shared/object-guards.js';
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

export function pathLooksUserConfigured<Value>(value: Value, home: string, delim: string) {
  if (!isString(value) || !value) {
    return false;
  }

  const normalizedHome = home.replaceAll('\\', '/');
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

export function mergePathValues<Primary, Fallback>(primary: Primary, fallback: Fallback, delim: string) {
  const seen = new Set<string>();
  const result: string[] = [];

  const addSegments = <Value>(value: Value) => {
    if (!isString(value) || !value) return;
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
