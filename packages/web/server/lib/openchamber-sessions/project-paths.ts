import type { resolvePrimaryWorktreeRoot, resolveWorktreeTopLevel } from '../git/index.js';

type Project = { path: string };

export const toPathKey = (value: string | undefined) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
export const holdsPath = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}/`);

const checkoutRootOf = (directoryKey: string, folder: string | null) => {
  if (folder === null) return null;
  if (folder === '') return directoryKey;
  return directoryKey.endsWith(`/${folder}`) ? directoryKey.slice(0, -folder.length - 1) : null;
};

export const projectPathInPrimaryCheckout = (primaryRoot: string, folder: string, projects: Project[]) => {
  let best: { path: string; folder: string } | null = null;
  for (const project of projects) {
    const projectKey = toPathKey(project.path);
    if (!holdsPath(primaryRoot, projectKey)) continue;
    const projectFolder = projectKey.slice(primaryRoot.length).replace(/^\/+/, '');
    if (projectFolder && !holdsPath(projectFolder, folder)) continue;
    if (!best || projectFolder.length > best.folder.length) best = { path: project.path, folder: projectFolder };
  }
  return best?.path ?? null;
};

export const createRegisteredProjectLookup = (git: {
  resolveWorktreeTopLevel: typeof resolveWorktreeTopLevel;
  resolvePrimaryWorktreeRoot: typeof resolvePrimaryWorktreeRoot;
}) => async (directory: string, projects: Project[]) => {
  const directoryKey = toPathKey(directory);
  const prefix = (await git.resolveWorktreeTopLevel(directory).catch(() => null))?.prefix;
  const folder = prefix === undefined ? null : toPathKey(prefix);
  const checkoutRoot = checkoutRootOf(directoryKey, folder);
  let containing: string | null = null;
  for (const project of projects) {
    const projectKey = toPathKey(project.path);
    if (!holdsPath(projectKey, directoryKey)) continue;
    if (checkoutRoot && !holdsPath(checkoutRoot, projectKey)) continue;
    if (!containing || projectKey.length > toPathKey(containing).length) containing = project.path;
  }
  if (containing) return containing;
  if (folder === null) return null;
  const primary = await git.resolvePrimaryWorktreeRoot(directory).catch(() => null);
  return primary ? projectPathInPrimaryCheckout(toPathKey(primary.root), folder, projects) : null;
};
