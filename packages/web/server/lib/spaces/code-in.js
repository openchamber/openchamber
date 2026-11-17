
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  EXT_UNCARRIABLE, INNER_MARGIN_SECONDS, SNAPSHOT_IDENTITY, buildExtUrl, createTransferSession, innerSeconds, line,
  objectIdPattern, requireInnerMargin, requireTimeout, spaceRefPrefix, startRef, zeroObjectId,
} from './code-transfer.js';
import { SpaceError } from './errors.js';
import { tail } from './exec-http.js';
import { requireSpaceId } from './labels.js';
import { IMAGE_GIT, IMAGE_ONLY_PATH, IMAGE_SH, IMAGE_TIMEOUT, requireSpaceProjectPath, spaceHistoryPath, spaceProjectPath } from './layout.js';

const SNAPSHOT_TIMEOUT_MS = 10 * 60_000;
const LIST_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const HISTORY_TIMEOUT_MS = 30 * 60_000;
const PUSH_MAX_OUTPUT_BYTES = 1024 * 1024;
const INSIDE_TIMEOUT_MS = 5 * 60_000;

const MODES = new Set(['uncommitted', 'clean']);
const COPYABLE_VALUE = /^[^\x00-\x1f\x7f]{1,256}$/;

const INSIDE_BASE = 'refs/openchamber/base';
const INSIDE_START_INDEX = 'refs/openchamber/start-index';
const INSIDE_START = 'refs/openchamber/start';

const PATH_IN_USE_EXIT_CODE = 3;
// external: https://git-scm.com/docs/git-init/2.28.0 --initial-branch requires Git 2.28 inside the space.
const INIT_SCRIPT = [
  IMAGE_ONLY_PATH,
  `{ [ ! -e "$1" ] && [ ! -L "$1" ]; } || exit ${PATH_IN_USE_EXIT_CODE};`,
  'if [ -n "$3" ]; then git init --quiet --object-format="$2" --initial-branch="$3" "$1"; else git init --quiet --object-format="$2" "$1"; fi',
  '&& git -C "$1" config receive.shallowUpdate true',
].join(' ');
const IS_SHALLOW_SCRIPT = `${IMAGE_ONLY_PATH} cd "$1" && git rev-parse --is-shallow-repository`;
const UNFOLD_SCRIPT = [
  IMAGE_ONLY_PATH,
  'cd "$1" || exit 1;',
  'if [ -n "$3" ]; then git config user.name "$3" || exit 1; fi;',
  'if [ -n "$4" ]; then git config user.email "$4" || exit 1; fi;',
  `if [ -n "$2" ]; then git checkout --quiet -B "$2" ${INSIDE_START}; else git checkout --quiet --detach ${INSIDE_START}; fi || exit 1;`,
  `git reset --quiet --soft ${INSIDE_BASE} && git read-tree ${INSIDE_START_INDEX}`,
].join(' ');
const INIT_SIDE_SCRIPT = `${IMAGE_ONLY_PATH} rm -rf "$1" && git init --quiet --bare --object-format="$2" "$1"`;
const UNSHALLOW_SCRIPT = [
  IMAGE_ONLY_PATH,
  'cd "$1" || { rm -rf "$2"; exit 1; };',
  `timeout -s KILL "$3" git fetch --quiet --unshallow --no-tags "$2" +${INSIDE_BASE}:${INSIDE_BASE};`,
  'status=$?; rm -rf "$2"; exit $status',
].join(' ');
const REMOVE_SIDE_SCRIPT = `${IMAGE_ONLY_PATH} rm -rf "$1"`;

const receivePackUrl = (execArgv, seconds, target) => buildExtUrl([
  ...execArgv, IMAGE_TIMEOUT, '-s', 'KILL', String(seconds), IMAGE_GIT, 'receive-pack', target,
]);

const SNAPSHOT_REFUSALS = new Set([
  'invalid_space_id', 'invalid_snapshot_mode', 'git_version_unreadable', 'git_too_old', 'project_folder_missing',
  'not_a_git_work_tree', 'repository_has_no_commit', 'repository_has_unmerged_changes', 'space_ref_exists',
  'invalid_branch_name', 'project_folder_does_not_travel', 'git_command_failed',
]);
const BRING_CODES = new Set(['code_transfer_failed', 'code_unfold_failed', 'space_path_in_use', 'git_command_failed']);

const asBringFailure = (error, passing, step) => {
  const ours = error instanceof SpaceError;
  if (ours && passing.has(error.code)) return error;
  return new SpaceError(
    'code_transfer_failed',
    ours ? error.message : `Code in failed on the host: ${error.message}`,
    { step: ours ? step : 'host side', ...error.details, cause: error.code ?? null },
  );
};

const historyRuns = new Map();
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const asHistoryFailure = (error, step) => {
  if (error instanceof SpaceError && error.code === 'history_transfer_failed') return error;
  const ours = error instanceof SpaceError;
  const details = ours && error.code === 'code_transfer_failed' ? error.details : { step, ...error.details, cause: error.code ?? null };
  return new SpaceError('history_transfer_failed', ours ? error.message : `The history failed on the host: ${error.message}`, details);
};

export function createCodeIn({ git, place, temporaryDirectory = os.tmpdir(), removeDirectory }) {
  const { withHostGit, requireGitVersion, requireWorkTree } = createTransferSession({ git, temporaryDirectory, removeDirectory, name: 'code in' });

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

  const snapshotUncommitted = async (g, directory, top, base) => {
    const index = path.join(directory, 'index');
    const realIndex = path.resolve(top, line(await g.output(top, ['rev-parse', '--git-path', 'index'])));
    try {
      await fs.copyFile(realIndex, index);
    } catch (error) {
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
    if (prefix !== '' && line((await g.run(top, ['cat-file', '-t', `${start}:${prefix.replace(/\/$/, '')}`])).stdout) !== 'tree') {
      throw new SpaceError('project_folder_does_not_travel', `The project folder ${prefix.replace(/\/$/, '')} is empty or ignored by git, so none of it would reach the space. Open the repository folder, or a folder that holds files git keeps, and create the space from there.`);
    }
    await g.output(top, ['update-ref', ref, start, zeroObjectId(objectFormat)]);
    return { repository: top, prefix, objectFormat, base, staged, start, branch, identity, ref };
  };

  const takeSnapshot = (request) => withHostGit('code_in_failed', (g, directory) => snapshot(g, directory, request ?? {}));

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

  const makeSender = async (g, directory, top, objectFormat, shallowBase) => {
    const sender = path.join(directory, 'sender.git');
    await g.output(directory, ['init', '--quiet', '--bare', '--template=', `--object-format=${objectFormat}`, sender]);
    const objects = path.resolve(top, line(await g.output(top, ['rev-parse', '--git-path', 'objects'])));
    await fs.mkdir(path.join(sender, 'objects', 'info'), { recursive: true });
    await fs.writeFile(path.join(sender, 'objects', 'info', 'alternates'), `${objects.replaceAll('\\', '/')}\n`);
    if (shallowBase) {
      await fs.writeFile(path.join(sender, 'shallow'), `${shallowBase}\n`);
    }
    return sender;
  };

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
      throw new SpaceError('code_transfer_failed', `Sending ${what} into the space failed: ${tail(result.stderr) || `exit code ${result.code}`}`, { step: what, cause: null });
    }
  };

  const inside = (spaceId, script, args, timeoutMs = INSIDE_TIMEOUT_MS) => place.exec(spaceId, [IMAGE_SH, '-c', script, 'sh', ...args], { timeoutMs });

  const insideFailure = (code, what, result) => new SpaceError(
    code,
    `Could not ${what} inside the space: ${tail(result.stderr) || `exit code ${result.code}`}`,
    { step: what, cause: 'inside_command_failed', exitCode: result.code },
  );

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

  const sendHistory = (request) => {
    const { repository, spaceId, spacePath, base, timeoutMs = HISTORY_TIMEOUT_MS, innerMarginSeconds = INNER_MARGIN_SECONDS } = request ?? {};
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
    const top = await requireWorkTree(g, repository);
    const objectFormat = line(await g.output(top, ['rev-parse', '--show-object-format']));
    if (line(await g.output(top, ['rev-parse', '--is-shallow-repository'])) === 'true') {
      return { status: 'host_shallow' };
    }
    if (!objectIdPattern(objectFormat).test(String(base ?? '')) || (await g.run(top, ['cat-file', '-e', `${base}^{commit}`])).code !== 0) {
      throw new SpaceError('history_transfer_failed', 'The base of the history is not a commit of this repository.', { step: 'check the base', cause: 'not_a_commit' });
    }
    const execArgv = await place.execArgv(spaceId);
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
