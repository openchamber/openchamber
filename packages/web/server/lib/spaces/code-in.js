// Code in: the project's code travels from the user's repository into a space, as git objects over
// the place's exec channel. No network, no ports, no archives, no shared folders. The host drives
// every step. The command sequences follow docs/isolated-spaces/stage-0/e4-git-over-exec.md.
//
// The space is hostile from the first moment, the receiving side of every push included: it can
// refuse, hang, lie about what it has, or print a lot. None of that may change the user's
// repository or leave a process running on the host.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SpaceError } from './errors.js';
import { tail } from './exec-http.js';
import { isGitVersionAtLeast, parseGitVersion } from './host-git.js';
import { requireSpaceId } from './labels.js';
import { IMAGE_GIT, IMAGE_ONLY_PATH, IMAGE_SH, IMAGE_TIMEOUT, requireSpaceProjectPath, spaceHistoryPath, spaceProjectPath } from './layout.js';

const SNAPSHOT_TIMEOUT_MS = 10 * 60_000;
const LIST_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const HISTORY_TIMEOUT_MS = 30 * 60_000;
// A push prints nothing with `--quiet`. What it does print comes from the receiving side, which
// is the space. More than this, and the transfer is killed like a hanging one.
const PUSH_MAX_OUTPUT_BYTES = 1024 * 1024;
// The limit inside is the host's limit plus this margin, so it never ends a push the host still
// waits for, and a push the host killed leaves nothing running inside once it passes.
const INNER_MARGIN_SECONDS = 5;
const MAX_INNER_MARGIN_SECONDS = 3600;
const INSIDE_TIMEOUT_MS = 5 * 60_000;
// The oldest host git code in works with. `git init --object-format` first appears in the git-init
// manual of 2.27.0; `rev-parse --show-object-format` and `add --pathspec-from-file` in 2.25.0; every
// other option used here is older. See DOCUMENTATION.md, "Host git".
const GIT_VERSION_FLOOR = Object.freeze({ major: 2, minor: 27, patch: 0 });
const GIT_VERSION_FLOOR_TEXT = '2.27';

// The snapshot commits carry a fixed identity, so a user without `user.name` can still create a space.
const SNAPSHOT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'OpenChamber',
  GIT_AUTHOR_EMAIL: 'spaces@openchamber.invalid',
  GIT_COMMITTER_NAME: 'OpenChamber',
  GIT_COMMITTER_EMAIL: 'spaces@openchamber.invalid',
});

const MODES = new Set(['uncommitted', 'clean']);
// A git `ext::` URL splits on spaces itself and cannot carry these at all.
const EXT_UNCARRIABLE = /[\x00-\x1f\x7f]/;
// A value that is copied into the space's git config: one line, and short.
const COPYABLE_VALUE = /^[^\x00-\x1f\x7f]{1,256}$/;

// Refs inside the space. The host pushes only here, never to refs/heads/*.
const INSIDE_BASE = 'refs/openchamber/base';
const INSIDE_START_INDEX = 'refs/openchamber/start-index';
const INSIDE_START = 'refs/openchamber/start';

const spaceRefPrefix = (spaceId) => `refs/openchamber/spaces/${requireSpaceId(spaceId)}/`;
const startRef = (spaceId) => `${spaceRefPrefix(spaceId)}start`;

// The fixed scripts that run inside the space. Every value is a positional argument.
// Exit code 3 of the init script means the project path is already there.
const PATH_IN_USE_EXIT_CODE = 3;
// The repository starts on the host's branch, so no stray `master` shows up in the agent's reflog.
// `--initial-branch` needs git 2.28 inside; the image has 2.39.5. A detached host HEAD keeps git's default.
const INIT_SCRIPT = [
  IMAGE_ONLY_PATH,
  `{ [ ! -e "$1" ] && [ ! -L "$1" ]; } || exit ${PATH_IN_USE_EXIT_CODE};`,
  'if [ -n "$3" ]; then git init --quiet --object-format="$2" --initial-branch="$3" "$1"; else git init --quiet --object-format="$2" "$1"; fi',
  '&& git -C "$1" config receive.shallowUpdate true',
].join(' ');
// Prints `true` or `false`: whether the space's repository still waits for its history.
const IS_SHALLOW_SCRIPT = `${IMAGE_ONLY_PATH} cd "$1" && git rev-parse --is-shallow-repository`;
// Identity first, so the reflog of the checkout carries it. Then the working tree becomes the
// start snapshot, the branch moves back to the base, and the index becomes the staged snapshot.
const UNFOLD_SCRIPT = [
  IMAGE_ONLY_PATH,
  'cd "$1" || exit 1;',
  'if [ -n "$3" ]; then git config user.name "$3" || exit 1; fi;',
  'if [ -n "$4" ]; then git config user.email "$4" || exit 1; fi;',
  `if [ -n "$2" ]; then git checkout --quiet -B "$2" ${INSIDE_START}; else git checkout --quiet --detach ${INSIDE_START}; fi || exit 1;`,
  `git reset --quiet --soft ${INSIDE_BASE} && git read-tree ${INSIDE_START_INDEX}`,
].join(' ');
// The side repository is made fresh: whatever the agent left under that name goes first.
const INIT_SIDE_SCRIPT = `${IMAGE_ONLY_PATH} rm -rf "$1" && git init --quiet --bare --object-format="$2" "$1"`;
// The fetch has a limit of its own inside, because the host's limit on `exec` ends the docker
// CLI only. The side repository goes whatever the fetch did.
const UNSHALLOW_SCRIPT = [
  IMAGE_ONLY_PATH,
  'cd "$1" || { rm -rf "$2"; exit 1; };',
  `timeout -s KILL "$3" git fetch --quiet --unshallow --no-tags "$2" +${INSIDE_BASE}:${INSIDE_BASE};`,
  'status=$?; rm -rf "$2"; exit $status',
].join(' ');
const REMOVE_SIDE_SCRIPT = `${IMAGE_ONLY_PATH} rm -rf "$1"`;

// One line of git output, without its line end.
const line = (text) => text.replace(/\r?\n$/, '');
const zeroObjectId = (objectFormat) => '0'.repeat(objectFormat === 'sha256' ? 64 : 40);
const objectIdPattern = (objectFormat) => (objectFormat === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/);
const innerSeconds = (timeoutMs, marginSeconds) => Math.ceil(timeoutMs / 1000) + marginSeconds;

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;

/** The host's limit on a push, in whole milliseconds from a second to a day. */
const requireTimeout = (value) => {
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new SpaceError('invalid_timeout', `The time limit of a transfer is a whole number of milliseconds from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  }
  return value;
};

/** The margin between the host's limit and the one inside, in whole seconds: a length, and nothing else. */
const requireInnerMargin = (value) => {
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

/** The receiving side of a push into the space: fixed programs by absolute path, under the space's own time limit. */
const receivePackUrl = (execArgv, seconds, target) => buildExtUrl([
  ...execArgv, IMAGE_TIMEOUT, '-s', 'KILL', String(seconds), IMAGE_GIT, 'receive-pack', target,
]);

/**
 * `git` is a host git from `createHostGit`, `place` the place the space lives on. `temporaryDirectory`
 * is where the index copy, the sending repository and an empty hooks folder live while one call runs.
 */
// What `bringCodeIn` passes through as it is: the refusals of the snapshot, then its own codes after
// it. Everything else, a failure of the place or of the runner among it, becomes code_transfer_failed
// with that code as `details.cause`.
const SNAPSHOT_REFUSALS = new Set([
  'invalid_space_id', 'invalid_snapshot_mode', 'git_version_unreadable', 'git_too_old', 'project_folder_missing',
  'not_a_git_work_tree', 'repository_has_no_commit', 'repository_has_unmerged_changes', 'space_ref_exists',
  'invalid_branch_name', 'project_folder_does_not_travel', 'git_command_failed',
]);
const BRING_CODES = new Set(['code_transfer_failed', 'code_unfold_failed', 'space_path_in_use', 'git_command_failed']);

/** `error` as `bringCodeIn` rejects with it: as it is when `passing` names its code, else as code_transfer_failed. */
const asBringFailure = (error, passing, step) => {
  const ours = error instanceof SpaceError;
  if (ours && passing.has(error.code)) return error;
  return new SpaceError(
    'code_transfer_failed',
    ours ? error.message : `Code in failed on the host: ${error.message}`,
    { step: ours ? step : 'host side', ...error.details, cause: error.code ?? null },
  );
};

// History runs under way in this process, by space id: `{ spacePath, base, checkout, promise }`. At module
// level, so two `createCodeIn` instances share them too. Two processes are not coordinated.
const historyRuns = new Map();
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** `error` as `sendHistory` rejects with it: always history_transfer_failed, with a step and the root cause. */
const asHistoryFailure = (error, step) => {
  if (error instanceof SpaceError && error.code === 'history_transfer_failed') return error;
  const ours = error instanceof SpaceError;
  // A failed push already names its own step and cause.
  const details = ours && error.code === 'code_transfer_failed' ? error.details : { step, ...error.details, cause: error.code ?? null };
  return new SpaceError('history_transfer_failed', ours ? error.message : `The history failed on the host: ${error.message}`, details);
};

const removeWithRetries = (directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

export function createCodeIn({ git, place, temporaryDirectory = os.tmpdir(), removeDirectory = removeWithRetries }) {
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
      directory = await fs.mkdtemp(path.join(temporaryDirectory, 'openchamber-code-in-'));
    } catch (error) {
      throw new SpaceError(failureCode, `Could not make a temporary folder for code in: ${error.message}`, { step: 'make a temporary folder', cause: error.code ?? null });
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
        : new SpaceError(failureCode, `Code in failed on the host: ${error.message}`, { step: 'host side', cause: error.code ?? null });
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
    const unreadable = (cause) => new SpaceError('git_version_unreadable', 'Could not tell which git this computer has. Code in needs git to be installed and working.', { cause });
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
      throw new SpaceError('git_too_old', `Code in needs git ${GIT_VERSION_FLOOR_TEXT} or newer, and this computer has git ${version.major}.${version.minor}.${version.patch}. Update git, then create the space.`, { version });
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
      throw new SpaceError('not_a_git_work_tree', `${repository} is not inside a git working tree. Code can travel into a space only from a git repository.`);
    }
    // git answers with forward slashes on Windows too.
    return path.resolve(line(await g.output(repository, ['rev-parse', '--show-toplevel'])));
  };

  /** What a transfer needs to know about the repository, after the refusals that come first. */
  const inspectRepository = async (g, repository) => {
    const top = await requireWorkTree(g, repository);
    const head = await g.run(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head.code !== 0) {
      throw new SpaceError('repository_has_no_commit', 'The repository has no commit yet. Make a first commit, then create the space.');
    }
    if ((await g.output(top, ['ls-files', '--unmerged', '-z'], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES })) !== '') {
      throw new SpaceError('repository_has_unmerged_changes', 'The repository is in the middle of a merge or a rebase with unresolved conflicts. Finish or abort it, then create the space.');
    }
    return {
      top,
      prefix: line(await g.output(repository, ['rev-parse', '--show-prefix'])),
      base: line(head.stdout),
      objectFormat: line(await g.output(top, ['rev-parse', '--show-object-format'])),
    };
  };

  /** The host's current branch, checked by git's own rule, or null for a detached HEAD. */
  const readBranch = async (g, top) => {
    const head = await g.run(top, ['symbolic-ref', '--quiet', 'HEAD']);
    const full = head.code === 0 ? line(head.stdout) : '';
    if (!full.startsWith('refs/heads/')) {
      return null;
    }
    const name = full.slice('refs/heads/'.length);
    const check = await g.run(top, ['check-ref-format', '--branch', name]);
    if (check.code !== 0 || line(check.stdout) !== name || name.startsWith('-') || EXT_UNCARRIABLE.test(name)) {
      throw new SpaceError('invalid_branch_name', 'The name of the current branch is not one git accepts as a branch name.');
    }
    return name;
  };

  /**
   * The user's name and email from their git config, each only when it is one short line. Nothing
   * else travels, and nothing is guessed: git's own guess would put the host's machine name into the space.
   */
  const readIdentity = async (g, top) => {
    const value = async (key) => {
      const result = await g.run(top, ['config', '--get', key]);
      const text = result.code === 0 ? line(result.stdout) : '';
      return COPYABLE_VALUE.test(text) ? text : '';
    };
    return { name: await value('user.name'), email: await value('user.email') };
  };

  const listUntracked = async (g, top) => (await g.output(top, ['ls-files', '--others', '--exclude-standard', '-z'], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES }))
    .split('\0')
    .filter(Boolean);

  /**
   * The untracked files that travel with uncommitted changes: exactly what the snapshot's `add` adds,
   * because both read the same ignore rules with the same config. An untracked folder that is a git
   * repository of its own does not travel at all, see `snapshotUncommitted`, and is listed under
   * `notTravelling`. Sizes are the sizes on disk, and null for a file that vanished in between.
   */
  const listTravellingFiles = (repository) => withHostGit('code_in_failed', async (g) => {
    const top = await requireWorkTree(g, repository);
    const files = [];
    const notTravelling = [];
    for (const entry of await listUntracked(g, top)) {
      if (entry.endsWith('/')) {
        notTravelling.push({ path: entry.slice(0, -1), kind: 'repository' });
        continue;
      }
      try {
        const stats = await fs.lstat(path.join(top, entry));
        files.push({ path: entry, kind: stats.isSymbolicLink() ? 'symlink' : 'file', size: stats.size });
      } catch {
        files.push({ path: entry, kind: 'file', size: null });
      }
    }
    return { files, notTravelling, totalBytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0) };
  });

  /**
   * The first-release limits a create dialog warns about: submodule paths, which arrive empty, and
   * whether Git LFS is in use, whose files arrive as pointers.
   */
  const readTransferLimits = (repository) => withHostGit('code_in_failed', async (g) => {
    const top = await requireWorkTree(g, repository);
    const staged = (await g.output(top, ['ls-files', '--stage', '-z'], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES })).split('\0').filter(Boolean);
    const submodules = staged.filter((entry) => entry.startsWith('160000 ')).map((entry) => entry.slice(entry.indexOf('\t') + 1));
    const lfsFiles = (await g.output(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(attr:filter=lfs)'], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES }))
      .split('\0')
      .filter(Boolean);
    return { submodules, usesLfs: lfsFiles.length > 0 };
  });

  const commitTree = async (g, top, tree, parent, message) => line(await g.output(
    top,
    ['commit-tree', '--no-gpg-sign', tree, '-p', parent, '-m', message],
    { env: SNAPSHOT_IDENTITY },
  ));

  /**
   * Two snapshot commits from a copy of the index, with the user's normal config. The working
   * tree, the real index and every ref stay as they were. `add` does write loose objects into
   * the repository and runs the user's clean filters, as their own `git add` would.
   * `core.splitIndex=false` keeps the copy from writing a shared index file into the user's `.git`.
   *
   * Untracked folders that are git repositories of their own stay out, by pathspec with literal
   * magic so no name is read as a pattern. `add` would record each as a gitlink, it would arrive
   * as an empty folder the space's git does not see, and the start would then differ from the
   * space's working tree before the agent did anything.
   */
  const snapshotUncommitted = async (g, directory, top, base) => {
    const index = path.join(directory, 'index');
    const realIndex = path.resolve(top, line(await g.output(top, ['rev-parse', '--git-path', 'index'])));
    try {
      await fs.copyFile(realIndex, index);
    } catch (error) {
      // No index file is an empty index to git, and a missing copy is the same to it.
      if (error.code !== 'ENOENT') throw error;
    }
    const options = { env: { GIT_INDEX_FILE: index }, timeoutMs: SNAPSHOT_TIMEOUT_MS };
    const unsplit = ['-c', 'core.splitIndex=false'];
    const nested = (await listUntracked(g, top)).filter((entry) => entry.endsWith('/')).map((entry) => entry.slice(0, -1));
    const pathspecs = ['.', ...nested.map((entry) => `:(exclude,literal)${entry}`)];
    const stagedTree = line(await g.output(top, [...unsplit, 'write-tree'], options));
    await g.output(top, [...unsplit, 'add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], { ...options, stdin: `${pathspecs.join('\0')}\0` });
    const workTree = line(await g.output(top, [...unsplit, 'write-tree'], options));
    const staged = await commitTree(g, top, stagedTree, base, 'openchamber: staged snapshot');
    const start = await commitTree(g, top, workTree, staged, 'openchamber: working tree snapshot');
    return { staged, start };
  };

  const snapshot = async (g, directory, { repository, spaceId, mode }) => {
    requireSpaceId(spaceId);
    if (!MODES.has(mode)) {
      throw new SpaceError('invalid_snapshot_mode', 'A snapshot is taken with the uncommitted changes or from the last commit');
    }
    await requireGitVersion(g, directory);
    const { top, prefix, base, objectFormat } = await inspectRepository(g, repository);
    const ref = startRef(spaceId);
    if ((await g.run(top, ['rev-parse', '--verify', '--quiet', ref])).code === 0) {
      throw new SpaceError('space_ref_exists', `The repository already holds a start snapshot for space ${spaceId}: code already went into that space once. Remove the space, which removes this snapshot too, and create a new one.`);
    }
    const branch = await readBranch(g, top);
    const identity = await readIdentity(g, top);
    let staged = base;
    let start = base;
    if (mode === 'uncommitted') {
      ({ staged, start } = await snapshotUncommitted(g, directory, top, base));
    }
    // A project in a subfolder needs that folder in the start, or the project path inside would not exist.
    if (prefix !== '' && line((await g.run(top, ['cat-file', '-t', `${start}:${prefix.replace(/\/$/, '')}`])).stdout) !== 'tree') {
      throw new SpaceError('project_folder_does_not_travel', `The project folder ${prefix.replace(/\/$/, '')} is empty or ignored by git, so none of it would reach the space. Open the repository folder, or a folder that holds files git keeps, and create the space from there.`);
    }
    // The old value of zero makes this a create: it never moves a ref that appeared in between.
    await g.output(top, ['update-ref', ref, start, zeroObjectId(objectFormat)]);
    return { repository: top, prefix, objectFormat, base, staged, start, branch, identity, ref };
  };

  /**
   * Takes the snapshot and keeps its start alive with the host ref `refs/openchamber/spaces/<id>/start`,
   * which 3b needs as the base of the result patch. `mode` is `uncommitted`, or `clean` for a start at
   * HEAD with nothing uncommitted. Refuses a directory outside a git working tree, a repository with no
   * commit, unresolved conflicts, a project folder that would not travel, and a space that already has
   * a start ref.
   */
  const takeSnapshot = (request) => withHostGit('code_in_failed', (g, directory) => snapshot(g, directory, request ?? {}));

  /** Deletes every host ref of this space under `refs/openchamber/spaces/<id>/`, in one transaction. Resolves the deleted names. */
  const removeSpaceRefs = (request) => withHostGit('code_in_failed', async (g) => {
    const { repository, spaceId } = request ?? {};
    requireSpaceId(spaceId);
    const top = await requireWorkTree(g, repository);
    const refs = (await g.output(top, ['for-each-ref', '--format=%(refname)', spaceRefPrefix(spaceId)])).split('\n').filter(Boolean);
    if (refs.length > 0) {
      await g.output(top, ['update-ref', '--stdin'], { stdin: refs.map((name) => `delete ${name}\n`).join('') });
    }
    return refs;
  });

  /** A bare repository in `directory` that reads the project's objects through alternates and copies none. */
  const makeSender = async (g, directory, top, objectFormat, shallowBase) => {
    const sender = path.join(directory, 'sender.git');
    // No template, so no hook of anybody's lands in it.
    await g.output(directory, ['init', '--quiet', '--bare', '--template=', `--object-format=${objectFormat}`, sender]);
    // `--git-path objects` names the common object store, which is right for a linked worktree too.
    const objects = path.resolve(top, line(await g.output(top, ['rev-parse', '--git-path', 'objects'])));
    await fs.mkdir(path.join(sender, 'objects', 'info'), { recursive: true });
    await fs.writeFile(path.join(sender, 'objects', 'info', 'alternates'), `${objects.replaceAll('\\', '/')}\n`);
    if (shallowBase) {
      await fs.writeFile(path.join(sender, 'shallow'), `${shallowBase}\n`);
    }
    return sender;
  };

  /**
   * One push from the sending repository into the space. The user's config must not make it do
   * anything: no hook (`--no-verify`, on top of the empty hooks folder), no signing, no tags, no
   * submodules, no push options. `protocol.ext.allow` is set here and nowhere else. A timeout
   * kills the whole process tree, because killing git alone leaves `docker exec` running.
   */
  const push = async (g, sender, url, refspecs, timeoutMs, what) => {
    let result;
    try {
      result = await g.run(sender, [
        '-c', 'protocol.ext.allow=always', '-c', 'push.pushOption=',
        'push', '--quiet', '--no-verify', '--no-signed', '--no-follow-tags', '--no-recurse-submodules',
        url, ...refspecs,
      ], { timeoutMs, maxOutputBytes: PUSH_MAX_OUTPUT_BYTES, killTree: true });
    } catch (error) {
      throw new SpaceError('code_transfer_failed', `Sending ${what} into the space did not finish: ${error.message}`, { step: what, cause: error.code ?? null });
    }
    if (result.code !== 0) {
      // The text comes from the receiving side, which is the space. It is shown, never parsed.
      throw new SpaceError('code_transfer_failed', `Sending ${what} into the space failed: ${tail(result.stderr) || `exit code ${result.code}`}`, { step: what, cause: null });
    }
  };

  /** A fixed script inside the space. Resolves the result for any exit code. */
  const inside = (spaceId, script, args, timeoutMs = INSIDE_TIMEOUT_MS) => place.exec(spaceId, [IMAGE_SH, '-c', script, 'sh', ...args], { timeoutMs });

  const insideFailure = (code, what, result) => new SpaceError(
    code,
    `Could not ${what} inside the space: ${tail(result.stderr) || `exit code ${result.code}`}`,
    { step: what, cause: 'inside_command_failed', exitCode: result.code },
  );

  /**
   * Brings the project's code into a new space, snapshot first: a plain repository at the space's
   * project path whose branch, index and working tree match the host's HEAD, index and working tree.
   * The history comes later, from `sendHistory`. On failure the host ref this call wrote is deleted;
   * what reached the space stays there, and the space itself is the unit to remove.
   *
   * Resolves `{ spacePath, projectPath, base, staged, start, branch, objectFormat, identityCopied }`.
   * `projectPath` is the project directory inside, which differs from `spacePath` when the project is
   * a subfolder of its repository. `identityCopied` is `{ name, email }`, each true when the user's
   * value went into the space repository's config; the agent can commit only when both are true.
   */
  const bringCodeIn = (request) => withHostGit('code_transfer_failed', async (g, directory) => {
    const { repository, spaceId, mode = 'uncommitted', timeoutMs = TRANSFER_TIMEOUT_MS, innerMarginSeconds = INNER_MARGIN_SECONDS } = request ?? {};
    requireInnerMargin(innerMarginSeconds);
    requireTimeout(timeoutMs);
    let taken;
    try {
      taken = await snapshot(g, directory, { repository, spaceId, mode });
    } catch (error) {
      throw asBringFailure(error, SNAPSHOT_REFUSALS, 'take the snapshot');
    }
    const spacePath = spaceProjectPath(spaceId, taken.repository);
    try {
      // Asked first: it refuses a space that is gone, stopped or not ours before anything runs inside.
      const execArgv = await place.execArgv(spaceId);
      const init = await inside(spaceId, INIT_SCRIPT, [spacePath, taken.objectFormat, taken.branch ?? '']);
      if (init.code === PATH_IN_USE_EXIT_CODE) {
        throw new SpaceError('space_path_in_use', `The space already holds a project at ${spacePath}. Code goes into a space once: remove this space and create a new one.`);
      }
      if (init.code !== 0) {
        throw insideFailure('code_transfer_failed', 'make the repository', init);
      }
      const url = receivePackUrl(execArgv, innerSeconds(timeoutMs, innerMarginSeconds), spacePath);
      const sender = await makeSender(g, directory, taken.repository, taken.objectFormat, taken.base);
      // Two pushes. One push of the base and the snapshot together failed on git 2.39.5, the image's git.
      await push(g, sender, url, [`${taken.base}:${INSIDE_BASE}`], timeoutMs, 'the base commit');
      await push(g, sender, url, [`${taken.staged}:${INSIDE_START_INDEX}`, `${taken.start}:${INSIDE_START}`], timeoutMs, 'the snapshot');
      const unfold = await inside(spaceId, UNFOLD_SCRIPT, [spacePath, taken.branch ?? '', taken.identity.name, taken.identity.email]);
      if (unfold.code !== 0) {
        throw insideFailure('code_unfold_failed', 'unfold the snapshot', unfold);
      }
    } catch (error) {
      const failure = asBringFailure(error, BRING_CODES, 'reach the space');
      const forget = await g.run(taken.repository, ['update-ref', '-d', taken.ref, taken.start]).catch((cause) => ({ code: -1, stderr: cause.message }));
      if (forget.code !== 0) {
        failure.details = { ...failure.details, refNotRemoved: taken.ref };
      }
      throw failure;
    }
    const projectPath = taken.prefix === '' ? spacePath : `${spacePath}/${taken.prefix.replace(/\/$/, '')}`;
    const { base, staged, start, branch, objectFormat, identity } = taken;
    return { spacePath, projectPath, base, staged, start, branch, objectFormat, identityCopied: { name: identity.name !== '', email: identity.email !== '' } };
  });

  /**
   * The history behind `base`, sent after the snapshot, while the agent may already be working. A
   * push cannot deepen a shallow receiver, so the history goes to a side repository inside the space
   * and a local `fetch --unshallow` takes it from there; the side repository is removed afterwards.
   * Nothing in the working tree, the index or HEAD inside changes, and commit ids stay the same.
   * `spacePath` is the one `bringCodeIn` returned: the host repository may have been renamed or
   * checked out elsewhere since, so it is not worked out again.
   *
   * Resolves `{ status: 'sent' }`, `{ status: 'already_complete' }` when the space's repository has its
   * history already and nothing was sent, or `{ status: 'host_shallow' }` when the host repository is
   * shallow itself and has no history to send. Calls for one space in this process share one run. Every failure rejects with `history_transfer_failed`, with the
   * step in `details.step` and the root cause in `details.cause`; the caller reports it, and the space
   * keeps working with a shallow history.
   */
  const sendHistory = (request) => {
    const { repository, spaceId, spacePath, base, timeoutMs = HISTORY_TIMEOUT_MS, innerMarginSeconds = INNER_MARGIN_SECONDS } = request ?? {};
    // Each call's own arguments are checked before it may join a run.
    let checkedPath;
    try {
      requireSpaceId(spaceId);
      checkedPath = requireSpaceProjectPath(spaceId, spacePath);
      requireInnerMargin(innerMarginSeconds);
      requireTimeout(timeoutMs);
      if (!OBJECT_ID.test(String(base ?? ''))) {
        throw new SpaceError('not_a_commit', 'The base of the history is not a commit id.');
      }
    } catch (error) {
      return Promise.reject(asHistoryFailure(error, 'check the request'));
    }
    // The side repository is one per space, so two runs for one space would break each other. A call
    // joins the run under way only when it asks for the same thing, from the same checkout; otherwise
    // it is refused.
    const checkout = path.resolve(String(repository ?? ''));
    const running = historyRuns.get(spaceId);
    if (running) {
      if (running.spacePath === checkedPath && running.base === base && running.checkout === checkout) return running.promise;
      return Promise.reject(new SpaceError('history_transfer_failed', `A history transfer for space ${spaceId} with other arguments is still running. Wait for it to end, then try again.`, { step: 'check the request', cause: 'history_in_progress' }));
    }
    const run = { spacePath: checkedPath, base, checkout, promise: null };
    run.promise = sendHistoryOnce({ repository, spaceId, spacePath: checkedPath, base, timeoutMs, innerMarginSeconds }).finally(() => {
      if (historyRuns.get(spaceId) === run) historyRuns.delete(spaceId);
    });
    historyRuns.set(spaceId, run);
    return run.promise;
  };

  const sendHistoryOnce = async ({ repository, spaceId, spacePath, base, timeoutMs, innerMarginSeconds }) => {
    try {
      return await withHostGit('history_transfer_failed', (g, directory) => history(g, directory, { repository, spaceId, spacePath, base, timeoutMs, innerMarginSeconds }));
    } catch (error) {
      throw asHistoryFailure(error, 'send the history');
    }
  };


  const history = async (g, directory, { repository, spaceId, spacePath: requestedPath, base, timeoutMs, innerMarginSeconds }) => {
    const spacePath = requireSpaceProjectPath(spaceId, requestedPath);
    await requireGitVersion(g, directory);
    // Only what the history needs. The user may be in the middle of a merge on the host by now,
    // and that has nothing to do with the history behind a commit that already travelled.
    const top = await requireWorkTree(g, repository);
    const objectFormat = line(await g.output(top, ['rev-parse', '--show-object-format']));
    if (line(await g.output(top, ['rev-parse', '--is-shallow-repository'])) === 'true') {
      return { status: 'host_shallow' };
    }
    if (!objectIdPattern(objectFormat).test(String(base ?? '')) || (await g.run(top, ['cat-file', '-e', `${base}^{commit}`])).code !== 0) {
      throw new SpaceError('history_transfer_failed', 'The base of the history is not a commit of this repository.', { step: 'check the base', cause: 'not_a_commit' });
    }
    // Asked first: it refuses a space that is gone, stopped or not ours before anything runs inside.
    const execArgv = await place.execArgv(spaceId);
    // A repository that is complete already has its history: from an earlier call, or from the agent.
    // The answer comes from inside and only decides whether to send; `false` costs the space itself.
    const shallow = await inside(spaceId, IS_SHALLOW_SCRIPT, [spacePath]);
    const answer = shallow.code === 0 ? shallow.stdout.trim() : '';
    if (answer === 'false') {
      return { status: 'already_complete' };
    }
    if (answer !== 'true') {
      throw insideFailure('history_transfer_failed', 'tell whether the repository still needs its history', shallow);
    }
    const side = spaceHistoryPath(spaceId);
    try {
      const init = await inside(spaceId, INIT_SIDE_SCRIPT, [side, objectFormat]);
      if (init.code !== 0) {
        throw insideFailure('history_transfer_failed', 'make the side repository for the history', init);
      }
      const url = receivePackUrl(execArgv, innerSeconds(timeoutMs, innerMarginSeconds), side);
      await push(g, await makeSender(g, directory, top, objectFormat, null), url, [`${base}:${INSIDE_BASE}`], timeoutMs, 'the history');
      const fetched = await inside(spaceId, UNSHALLOW_SCRIPT, [spacePath, side, String(innerSeconds(timeoutMs, innerMarginSeconds))], timeoutMs + INSIDE_TIMEOUT_MS);
      if (fetched.code !== 0) {
        throw insideFailure('history_transfer_failed', 'take the history into the repository', fetched);
      }
    } catch (error) {
      await inside(spaceId, REMOVE_SIDE_SCRIPT, [side]).catch(() => null);
      throw error;
    }
    return { status: 'sent' };
  };

  return { takeSnapshot, listTravellingFiles, readTransferLimits, removeSpaceRefs, bringCodeIn, sendHistory };
}
