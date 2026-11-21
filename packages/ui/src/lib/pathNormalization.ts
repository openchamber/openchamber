const WINDOWS_DRIVE_ROOT = /^(?:\/\/\?\/)?[A-Za-z]:\/+$/u;
const WINDOWS_DRIVE_PREFIX = /^(?:\/\/\?\/)?[A-Za-z]:$/u;
const UNC_SHARE_ROOT = /^\/\/(?:[^/?][^/]*\/[^/]+|\?\/UNC\/[^/]+\/[^/]+)$/iu;

const EDGE_WHITESPACE = /^\s|\s$/u;

const isAlreadyNormalized = (value: string): boolean => {
  if (value.length < 2 || value.charCodeAt(value.length - 1) === 47 || value.includes("\\")) return false;
  const first = value.charCodeAt(0);
  if (first >= 97 && first <= 122 && value.charCodeAt(1) === 58) return false;
  return !EDGE_WHITESPACE.test(value);
};

export const normalizePath = (value?: string | null): string | null => {
  if (typeof value !== "string") return null;
  if (isAlreadyNormalized(value)) return value;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const replaced = trimmed
    .replace(/\\/g, "/")
    .replace(/^([a-z]):/, (_, letter: string) => letter.toUpperCase() + ":");

  if (replaced === "/") return "/";
  if (WINDOWS_DRIVE_ROOT.test(replaced)) return replaced.replace(/\/+$/u, "/");
  const stripped = replaced.length > 1 ? replaced.replace(/\/+$/, "") : replaced;
  return stripped || null;
};

export const isFilesystemRoot = (directory: string): boolean => (
  directory === '/' || WINDOWS_DRIVE_ROOT.test(directory) || WINDOWS_DRIVE_PREFIX.test(directory) || UNC_SHARE_ROOT.test(directory)
);

export const getNormalizedParentDirectory = (directory: string): string | null => {
  if (isFilesystemRoot(directory)) return null;
  const separator = directory.lastIndexOf('/');
  if (separator < 0) return null;
  if (separator === 0) return '/';
  const parent = directory.slice(0, separator);
  return WINDOWS_DRIVE_PREFIX.test(parent) ? `${parent}/` : parent;
};

export const normalizeTerminalDirectory = (value: string): string => normalizePath(value) ?? '';
