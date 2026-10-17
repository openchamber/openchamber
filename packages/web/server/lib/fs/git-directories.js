import nodeFsPromises from 'node:fs/promises';
import nodePath from 'node:path';

// Nested repository discovery bounds: only shallow walks are useful for the
// Git tab's "pick a repository" picker, and deep/monorepo trees can explode
// otherwise. Directories deeper than maxDepth or beyond the visit cap are not
// searched; the walk says so through `complete` instead of failing.
export const GIT_DIRS_MAX_DEPTH = 3;
export const GIT_DIRS_MAX_DIRS = 100;
export const GIT_DIRS_SKIP_LIST = new Set(['node_modules', 'dist', 'build', '.venv', 'target', '.next']);

/**
 * Walks `rootPath` and returns every nested git repository path (a directory
 * containing a `.git` entry: a directory, a worktree pointer file, or a
 * symlink). A repository boundary stops descent: nested repos inside repos are
 * not reported. The root itself is never reported.
 *
 * `rootBoundaryIsTransparent` decides what the root's own `.git` entry means.
 * False keeps the established behavior: a repository at the root hides
 * everything below it and no walk runs. True walks past that entry, which is
 * what an unborn repository (`git init`, no commits yet) or an invalid `.git`
 * needs so nested repositories stay reachable. Boundaries below the root
 * always stop and report.
 *
 * Symlinked directories are followed, the way the file tree follows them: a
 * parent folder of links to repositories kept elsewhere is a common way to
 * group them into one project. Each real directory is walked once, so a link
 * loop or two links to one repository cannot repeat it, and repositories are
 * reported under the path the link gives them inside the project.
 * Breadth-first traversal checks shallow siblings before deeper subtrees can
 * exhaust the visit cap.
 *
 * `complete` is false when the walk could not check everything: a directory or
 * symlink the walk would have checked left unscanned by the depth cap, queued
 * directories left unscanned by the visit cap, an unreadable directory, a
 * realpath failure, or a symlink target that could not be stat'ed for a reason
 * other than a dangling link. Skip-list directories and the children below a
 * repository boundary are out of scope by design and leave it true. An
 * unreadable root still throws, for the route's error mapping.
 */
export const findGitDirectories = async ({
  rootPath,
  fsPromises = nodeFsPromises,
  path: pathModule = nodePath,
  maxDepth = GIT_DIRS_MAX_DEPTH,
  maxDirs = GIT_DIRS_MAX_DIRS,
  rootBoundaryIsTransparent = false,
}) => {
  const repositories = [];
  const walkedRealPaths = new Set();
  const queue = [{ dir: rootPath, depth: 0 }];
  let visited = 0;
  let complete = true;

  const scanDirectory = async (dir, depth) => {
    let realPath;
    try {
      realPath = await fsPromises.realpath(dir);
    } catch (error) {
      if (dir === rootPath) {
        throw error;
      }
      complete = false;
      return;
    }
    if (walkedRealPaths.has(realPath)) {
      return;
    }
    walkedRealPaths.add(realPath);

    let dirents;
    try {
      dirents = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      // Unreadable subtree: skip it unless it is the root itself, which the
      // route maps to 403/404/500 through the shared error handling.
      if (dir === rootPath) {
        throw error;
      }
      complete = false;
      return;
    }
    visited += 1;

    // A repository boundary stops descent by design, so its children are never
    // checked and must not make the walk look truncated. The one boundary whose
    // children stay in scope is the transparent root.
    const isRepoBoundary = dirents.some((dirent) => dirent.name === '.git');
    if (isRepoBoundary && !(dir === rootPath && rootBoundaryIsTransparent)) {
      if (dir !== rootPath) {
        repositories.push(dir);
      }
      return;
    }

    const subdirectories = [];
    for (const dirent of dirents) {
      if (dirent.name === '.git') {
        continue;
      }
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) {
        continue;
      }
      if (GIT_DIRS_SKIP_LIST.has(dirent.name)) {
        continue;
      }
      if (depth >= maxDepth) {
        // A directory or link this walk would have checked sits below.
        complete = false;
        continue;
      }
      if (dirent.isSymbolicLink()) {
        // A link to a file, or a dangling one, is not a place to look. Any
        // other failure leaves a directory the walk could not check.
        const target = await fsPromises.stat(pathModule.join(dir, dirent.name)).catch((error) => {
          if (error?.code !== 'ENOENT') {
            complete = false;
          }
          return null;
        });
        if (!target?.isDirectory()) {
          continue;
        }
      }
      subdirectories.push(dirent.name);
    }

    subdirectories.sort();
    for (const name of subdirectories) {
      queue.push({ dir: pathModule.join(dir, name), depth: depth + 1 });
    }
  };

  let index = 0;
  for (; index < queue.length && visited < maxDirs; index += 1) {
    const { dir, depth } = queue[index];
    await scanDirectory(dir, depth);
  }
  if (index < queue.length) {
    // The visit cap stopped the walk with directories still queued.
    complete = false;
  }

  return { repositories, complete };
};
