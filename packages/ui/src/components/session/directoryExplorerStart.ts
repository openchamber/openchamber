const toSlashes = (value: string): string => value.trim().replace(/\\/g, '/').replace(/\/+$/, '');

const ROOTED_PATH = /^(?:~(?:\/|$)|\/|[a-zA-Z]:\/)/;

export const isRootedBrowseQuery = (query: string): boolean => ROOTED_PATH.test(query.trimStart());

/**
 * What the path field means. A name without a root belongs to the folder being
 * browsed: the server would otherwise resolve it against its own working
 * directory, which is nowhere the person is looking.
 */
export const resolveBrowseQuery = (query: string, browsedFolder: string): string => (
  isRootedBrowseQuery(query) ? query.trimStart() : `${browsedFolder}${query.trimStart()}`
);

type ProjectPlace = { path: string; addedAt?: number };

const parentBrowseQuery = (projectPath: string, homeDirectory: string): string => {
  const path = toSlashes(projectPath);
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (!parent) return '~/';
  const home = toSlashes(homeDirectory);
  if (home && parent === home) return '~/';
  if (home && parent.startsWith(`${home}/`)) return `~${parent.slice(home.length)}/`;
  return `${parent}/`;
};

/**
 * Where the add-project picker starts: the folder holding the most recently
 * added project, since a new project usually sits beside the previous ones.
 * Home when there is none, shown as `~/...` when it lies under home.
 */
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

/** The folders projects live in, latest first, as path-field values. Home has its own entry. */
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
