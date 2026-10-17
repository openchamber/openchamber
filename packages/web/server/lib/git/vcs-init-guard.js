import os from 'node:os';
import path from 'node:path';
import { findGitDirectories, GIT_DIRS_MAX_DEPTH, GIT_DIRS_MAX_DIRS } from '../fs/git-directories.js';
import { parseVcsInitRequest, vcsInitRefusal, vcsInitRefusalBody } from './repository-root.js';
import { inspectRepositoryBoundary } from './service.js';

/** The header a caller sets to initialize Git although nested repositories exist below. */
export const VCS_INIT_CONFIRMATION_HEADER = 'x-openchamber-vcs-init-confirm';
export const VCS_INIT_CONFIRMATION_VALUE = '1';

/** The body a `POST /api/vcs/init` that needs confirmation is refused with. */
const vcsInitConfirmationBody = (message) => ({
  _tag: 'VcsInitConfirmationRequiredError',
  message,
  code: 'confirmation-required',
});

const confirmationRequested = (headers) => {
  // Node hands a repeated header over as an array; the first value decides.
  const value = [headers?.[VCS_INIT_CONFIRMATION_HEADER]].flat().find(Boolean);
  return String(value ?? '').trim() === VCS_INIT_CONFIRMATION_VALUE;
};

const describeRepositories = (repositories) => {
  const shown = repositories.slice(0, 3).join(', ');
  return repositories.length > 3 ? `${shown}, and ${repositories.length - 3} more` : shown;
};

const nestedRepositoriesRefusal = (repositories) => vcsInitConfirmationBody(
  `Nested Git repositories exist below this directory (${describeRepositories(repositories)}). `
  + `Initializing a repository here would hide them from OpenChamber's Git surfaces. `
  + `Send the ${VCS_INIT_CONFIRMATION_HEADER}: ${VCS_INIT_CONFIRMATION_VALUE} header to initialize anyway.`,
);

const incompleteScanRefusal = () => vcsInitConfirmationBody(
  'This directory could not be fully scanned for nested Git repositories, so some may exist below. '
  + `Initializing a repository here could hide them from OpenChamber's Git surfaces. `
  + `Send the ${VCS_INIT_CONFIRMATION_HEADER}: ${VCS_INIT_CONFIRMATION_VALUE} header to initialize anyway.`,
);

/**
 * The body OpenChamber answers a `POST /api/vcs/init` with, or null when the
 * request is not one or may go through. Home and filesystem roots keep the
 * existing `InvalidRequestError` refusal; a directory that is itself a
 * repository root (established or unborn) reinitializes it without creating a
 * new `.git`, so it passes. Anywhere else, nested repositories below or a scan
 * that could not check everything refuse with a confirmation-required body
 * unless the request carries the confirmation header. A failure inside the
 * check itself logs a warning and lets the request through: a guard that
 * cannot answer must not block a legitimate `git init`.
 */
export const resolveVcsInitRefusalBody = async (method, requestUrl, headers, home = os.homedir()) => {
  const request = parseVcsInitRequest(method, requestUrl, headers);
  if (!request) return null;

  const refusal = vcsInitRefusal(method, requestUrl, headers, home);
  if (refusal) return vcsInitRefusalBody(refusal);
  if (confirmationRequested(headers)) return null;

  try {
    const directory = path.resolve(request.directory);
    if (await inspectRepositoryBoundary(directory) !== 'none') {
      return null;
    }
    const { repositories, complete } = await findGitDirectories({
      rootPath: directory,
      maxDepth: GIT_DIRS_MAX_DEPTH,
      maxDirs: GIT_DIRS_MAX_DIRS,
      rootBoundaryIsTransparent: true,
    });
    if (repositories.length > 0) return nestedRepositoriesRefusal(repositories);
    if (!complete) return incompleteScanRefusal();
    return null;
  } catch (error) {
    console.warn('VCS init guard could not check for nested repositories:', error?.message || error);
    return null;
  }
};
