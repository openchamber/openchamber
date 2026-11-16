
import fs from 'node:fs/promises';
import path from 'node:path';

import { SpaceError } from './errors.js';
import { isGitVersionAtLeast, parseGitVersion } from './host-git.js';
import { requireSpaceId } from './labels.js';

// external: https://git-scm.com/docs/git-fetch/2.29.0 --no-write-fetch-head requires host Git 2.29.
const GIT_VERSION_FLOOR = Object.freeze({ major: 2, minor: 29, patch: 0 });
const GIT_VERSION_FLOOR_TEXT = '2.29';

export const SNAPSHOT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'OpenChamber',
  GIT_AUTHOR_EMAIL: 'spaces@openchamber.invalid',
  GIT_COMMITTER_NAME: 'OpenChamber',
  GIT_COMMITTER_EMAIL: 'spaces@openchamber.invalid',
});

export const EXT_UNCARRIABLE = /[\x00-\x1f\x7f]/;

export const INNER_MARGIN_SECONDS = 5;
const MAX_INNER_MARGIN_SECONDS = 3600;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;

export const spaceRefPrefix = (spaceId) => `refs/openchamber/spaces/${requireSpaceId(spaceId)}/`;
export const startRef = (spaceId) => `${spaceRefPrefix(spaceId)}start`;

export const line = (text) => text.replace(/\r?\n$/, '');
export const zeroObjectId = (objectFormat) => '0'.repeat(objectFormat === 'sha256' ? 64 : 40);
export const objectIdPattern = (objectFormat) => (objectFormat === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/);
export const innerSeconds = (timeoutMs, marginSeconds) => Math.ceil(timeoutMs / 1000) + marginSeconds;

export const requireTimeout = (value) => {
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new SpaceError('invalid_timeout', `The time limit of a transfer is a whole number of milliseconds from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  }
  return value;
};

export const requireInnerMargin = (value) => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_INNER_MARGIN_SECONDS) {
    throw new SpaceError('invalid_inner_margin', `The margin of the limit inside the space is a whole number of seconds from 1 to ${MAX_INNER_MARGIN_SECONDS}`);
  }
  return value;
};

// external: https://git-scm.com/docs/git-remote-ext Spaces and percent signs in ext arguments require percent escaping.
export function buildExtUrl(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new SpaceError('invalid_ext_argument', 'A command for git is a non-empty list of arguments');
  }
  const escaped = argv.map((argument) => {
    const text = String(argument);
    if (text === '' || EXT_UNCARRIABLE.test(text)) {
      throw new SpaceError('invalid_ext_argument', 'A command for git cannot carry an empty argument or a control character');
    }
    return text.replaceAll('%', '%%').replaceAll(' ', '% ');
  });
  return `ext::${escaped.join(' ')}`;
}

const removeWithRetries = (directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

export function createTransferSession({ git, temporaryDirectory, removeDirectory = removeWithRetries, name }) {
  const Name = `${name[0].toUpperCase()}${name.slice(1)}`;

  const withHostGit = async (failureCode, work) => {
    let directory;
    try {
      directory = await fs.mkdtemp(path.join(temporaryDirectory, `openchamber-${name.replace(' ', '-')}-`));
    } catch (error) {
      throw new SpaceError(failureCode, `Could not make a temporary folder for ${name}: ${error.message}`, { step: 'make a temporary folder', cause: error.code ?? null });
    }
    let outcome;
    let failed = false;
    try {
      const hooks = path.join(directory, 'no-hooks');
      await fs.mkdir(hooks);
      const isolated = ['-c', `core.hooksPath=${hooks.replaceAll('\\', '/')}`, '-c', 'core.fsmonitor='];
      const g = {
        run: (where, args, options) => git.run(where, [...isolated, ...args], options),
        output: (where, args, options) => git.output(where, [...isolated, ...args], options),
      };
      outcome = await work(g, directory);
    } catch (error) {
      failed = true;
      outcome = error instanceof SpaceError
        ? error
        : new SpaceError(failureCode, `${Name} failed on the host: ${error.message}`, { step: 'host side', cause: error.code ?? null });
    }
    const left = await removeDirectory(directory).then(() => false, () => true);
    if (failed) {
      if (left) outcome.details = { ...outcome.details, temporaryDirectoryLeft: directory };
      throw outcome;
    }
    return outcome;
  };

  const requireGitVersion = async (g, directory) => {
    const unreadable = (cause) => new SpaceError('git_version_unreadable', `Could not tell which git this computer has. ${Name} needs git to be installed and working.`, { cause });
    let result;
    try {
      result = await g.run(directory, ['version']);
    } catch (error) {
      throw unreadable(error.code ?? null);
    }
    const version = result.code === 0 ? parseGitVersion(result.stdout) : null;
    if (!version) {
      throw unreadable(null);
    }
    if (!isGitVersionAtLeast(version, GIT_VERSION_FLOOR)) {
      throw new SpaceError('git_too_old', `${Name} needs git ${GIT_VERSION_FLOOR_TEXT} or newer, and this computer has git ${version.major}.${version.minor}.${version.patch}. Update git, then try again.`, { version });
    }
  };

  const requireWorkTree = async (g, repository) => {
    const found = await fs.stat(repository).then((stats) => stats.isDirectory(), () => false);
    if (!found) {
      throw new SpaceError('project_folder_missing', `${repository} does not exist, or is not a folder.`);
    }
    const inside = await g.run(repository, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || line(inside.stdout) !== 'true') {
      throw new SpaceError('not_a_git_work_tree', `${repository} is not inside a git working tree. Code can travel between a space and this computer only for a git repository.`);
    }
    return path.resolve(line(await g.output(repository, ['rev-parse', '--show-toplevel'])));
  };

  return { withHostGit, requireGitVersion, requireWorkTree };
}
