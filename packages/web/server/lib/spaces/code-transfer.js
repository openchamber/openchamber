// What code in and code out share: the host git session that starts nothing of the user's, the one
// git version floor of the feature, the work tree check, the `ext::` URL, and the time limits of a
// transfer. Both directions follow docs/isolated-spaces/stage-0/e4-git-over-exec.md.

import fs from 'node:fs/promises';
import path from 'node:path';

import { SpaceError } from './errors.js';
import { isGitVersionAtLeast, parseGitVersion } from './host-git.js';
import { requireSpaceId } from './labels.js';

// The oldest host git the feature works with. `fetch --no-write-fetch-head` first appears in the
// git-fetch manual of 2.29.0 (the 2.28.0 page does not have it), and without it code out would write
// `FETCH_HEAD` into the user's `.git`. Code in needs 2.27.0: `git init --object-format`. Every other
// option either direction uses is older. See DOCUMENTATION.md, "Host git".
const GIT_VERSION_FLOOR = Object.freeze({ major: 2, minor: 29, patch: 0 });
const GIT_VERSION_FLOOR_TEXT = '2.29';

// Commits the host or the fixed scripts write carry a fixed identity, so a user without `user.name`
// can still create a space and bring its work out.
export const SNAPSHOT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'OpenChamber',
  GIT_AUTHOR_EMAIL: 'spaces@openchamber.invalid',
  GIT_COMMITTER_NAME: 'OpenChamber',
  GIT_COMMITTER_EMAIL: 'spaces@openchamber.invalid',
});

// A git `ext::` URL splits on spaces itself and cannot carry these at all.
export const EXT_UNCARRIABLE = /[\x00-\x1f\x7f]/;

// The limit inside is the host's limit plus this margin, so it never ends a transfer the host still
// waits for, and a transfer the host killed leaves nothing running inside once it passes.
export const INNER_MARGIN_SECONDS = 5;
const MAX_INNER_MARGIN_SECONDS = 3600;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;

export const spaceRefPrefix = (spaceId) => `refs/openchamber/spaces/${requireSpaceId(spaceId)}/`;
export const startRef = (spaceId) => `${spaceRefPrefix(spaceId)}start`;

/** One line of git output, without its line end. */
export const line = (text) => text.replace(/\r?\n$/, '');
export const zeroObjectId = (objectFormat) => '0'.repeat(objectFormat === 'sha256' ? 64 : 40);
export const objectIdPattern = (objectFormat) => (objectFormat === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/);
export const innerSeconds = (timeoutMs, marginSeconds) => Math.ceil(timeoutMs / 1000) + marginSeconds;

/** The host's limit on a transfer, in whole milliseconds from a second to a day. */
export const requireTimeout = (value) => {
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new SpaceError('invalid_timeout', `The time limit of a transfer is a whole number of milliseconds from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  }
  return value;
};

/** The margin between the host's limit and the one inside, in whole seconds: a length, and nothing else. */
export const requireInnerMargin = (value) => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_INNER_MARGIN_SECONDS) {
    throw new SpaceError('invalid_inner_margin', `The margin of the limit inside the space is a whole number of seconds from 1 to ${MAX_INNER_MARGIN_SECONDS}`);
  }
  return value;
};

/**
 * A git `ext::` URL for an argv. git-remote-ext splits the text after `ext::` on spaces itself, so a
 * space inside an argument is written `% ` and a percent `%%`, as its documentation says. The docker
 * CLI on Windows can live under a path with spaces. An empty argument or one with a control
 * character cannot be carried, and is refused. The URL goes to git as one argv element, never
 * through a shell.
 */
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

/**
 * The host side of one direction. `git` is a host git from `createHostGit`, `temporaryDirectory` where
 * a call's temporary folder lives, `removeDirectory` how it goes, injectable so a test can make it
 * fail. `name` is how messages call the direction, `code in` or `code out`.
 */
export function createTransferSession({ git, temporaryDirectory, removeDirectory = removeWithRetries, name }) {
  const Name = `${name[0].toUpperCase()}${name.slice(1)}`;

  /**
   * Runs `work(g, directory)` with a temporary directory and a host git `g` that starts nothing of
   * the user's. `core.hooksPath` points at an empty folder of ours: without it the user's
   * `post-index-change` hook ran three times per snapshot, with `GIT_INDEX_FILE` pointing at our
   * copy, and their `reference-transaction` hook ran on every write of our ref. `core.fsmonitor` is
   * empty: a user's fsmonitor program ran ten times per snapshot, and `core.fsmonitor=true` left a
   * `git fsmonitor--daemon` running on the host with its files in the user's `.git`. Empty, and not
   * `false`, because before git 2.36 the value is a command path, where `false` names a program.
   *
   * A failure that is not a SpaceError becomes one with `failureCode`. Removing the folder is retried,
   * and it never replaces the error of the work: when it still fails, the error says which folder was
   * left in `details.temporaryDirectoryLeft`. After a successful call a leftover folder is let go.
   */
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

  /** Refuses a host git older than the floor, with the version it needs. */
  const requireGitVersion = async (g, directory) => {
    const unreadable = (cause) => new SpaceError('git_version_unreadable', `Could not tell which git this computer has. ${Name} needs git to be installed and working.`, { cause });
    let result;
    try {
      result = await g.run(directory, ['version']);
    } catch (error) {
      // A git that cannot be started at all, missing among them.
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

  /** The top level of the work tree that `repository` is in, as a native path, or a refusal. */
  const requireWorkTree = async (g, repository) => {
    const found = await fs.stat(repository).then((stats) => stats.isDirectory(), () => false);
    if (!found) {
      throw new SpaceError('project_folder_missing', `${repository} does not exist, or is not a folder.`);
    }
    const inside = await g.run(repository, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || line(inside.stdout) !== 'true') {
      throw new SpaceError('not_a_git_work_tree', `${repository} is not inside a git working tree. Code can travel between a space and this computer only for a git repository.`);
    }
    // git answers with forward slashes on Windows too.
    return path.resolve(line(await g.output(repository, ['rev-parse', '--show-toplevel'])));
  };

  return { withHostGit, requireGitVersion, requireWorkTree };
}
