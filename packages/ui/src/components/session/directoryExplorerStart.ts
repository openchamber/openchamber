import { getNormalizedParentDirectory, isFilesystemRoot } from '@/lib/pathNormalization';

const toSlashes = (value: string): string => value.trim().replace(/\\/g, '/').replace(/\/+$/, '');

const ROOTED_PATH = /^(?:~(?:\/|$)|\/|[a-zA-Z]:\/)/;

export const isRootedBrowseQuery = (query: string): boolean => ROOTED_PATH.test(query.trimStart());

const withTrailingSeparator = (value: string): string => (value.endsWith('/') ? value : `${value}/`);

// external: https://learn.microsoft.com/en-us/dotnet/standard/io/file-path-formats A bare drive letter resolves relative to that drive; drive roots retain their slash.
export const trimTrailingSeparators = (value: string): string => {
  const trimmed = value.replace(/\/+$/u, '');
  if (!trimmed) return value ? '/' : value;
  return isFilesystemRoot(trimmed) && /:$/u.test(trimmed) ? `${trimmed}/` : trimmed;
};

export const joinBrowsePath = (folder: string, name: string): string => `${withTrailingSeparator(trimTrailingSeparators(folder))}${name}`;

export const getBrowseParentPath = (value: string): string | null => {
  const trimmed = trimTrailingSeparators(value.trim());
  if (!trimmed || trimmed === '~' || isFilesystemRoot(trimmed)) return null;
  const parent = getNormalizedParentDirectory(trimmed);
  return parent === null ? null : withTrailingSeparator(parent);
};

export const resolveBrowseQuery = (query: string, browsedFolder: string): string => (
  isRootedBrowseQuery(query) ? query.trimStart() : `${browsedFolder}${query.trimStart()}`
);

type ProjectPlace = { path: string; addedAt?: number };

const parentBrowseQuery = (projectPath: string, homeDirectory: string): string => {
  const path = trimTrailingSeparators(projectPath.trim().replace(/\\/g, '/'));
  if (isFilesystemRoot(path)) return withTrailingSeparator(path);
  const parent = getNormalizedParentDirectory(path);
  if (!parent) return '~/';
  if (isFilesystemRoot(parent)) return withTrailingSeparator(parent);
  const home = toSlashes(homeDirectory);
  if (home && parent === home) return '~/';
  if (home && parent.startsWith(`${home}/`)) return `~${parent.slice(home.length)}/`;
  return `${parent}/`;
};

export const initialBrowseQuery = (
  projects: ReadonlyArray<ProjectPlace>,
  homeDirectory: string,
): string => {
  let latest: ProjectPlace | null = null;
  for (const project of projects) {
    if (!project.path.trim()) continue;
    if (!latest || (project.addedAt ?? 0) >= (latest.addedAt ?? 0)) latest = project;
  }
  return latest ? parentBrowseQuery(latest.path, homeDirectory) : '~/';
};

const PROJECT_PLACES = 3;

export const projectBrowsePlaces = (
  projects: ReadonlyArray<ProjectPlace>,
  homeDirectory: string,
): string[] => {
  const latestFirst = projects
    .filter((project) => project.path.trim())
    .sort((left, right) => (right.addedAt ?? 0) - (left.addedAt ?? 0));
  const places = new Set(latestFirst.map((project) => parentBrowseQuery(project.path, homeDirectory)));
  places.delete('~/');
  return [...places].slice(0, PROJECT_PLACES);
};

type BrowseListMemory = { key: string | null; ready: boolean };

export const browseListMemory = ({ runtimeKey, openCodeView, browseDirectory, filter = '', showHidden = false, listedDirectory, loading, failed }: {
  runtimeKey: string;
  openCodeView: boolean;
  browseDirectory: string;
  filter?: string;
  showHidden?: boolean;
  listedDirectory: string;
  loading: boolean;
  failed: boolean;
}): BrowseListMemory => {
  if (openCodeView) return { key: `explorer:${runtimeKey}:opencode`, ready: true };
  const folder = trimTrailingSeparators(browseDirectory.trim().replace(/\\/g, '/'));
  if (!folder) return { key: null, ready: false };
  const listed = trimTrailingSeparators(listedDirectory.trim().replace(/\\/g, '/'));
  const rows = `${showHidden ? ':hidden' : ''}${filter ? `:filter:${filter}` : ''}`;
  return { key: `explorer:${runtimeKey}:${folder}${rows}`, ready: !loading && !failed && listed === folder };
};
