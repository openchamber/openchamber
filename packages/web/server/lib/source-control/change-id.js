import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isString } from '../shared/guards.js';

/**
 * Change-Ids of a branch's commits, for hosts that find a change by the
 * `Change-Id:` trailer of the commit that was pushed (Gerrit) rather than by
 * the branch name.
 *
 * Trailers are parsed by Git itself (`git interpret-trailers --parse`), so a
 * `Change-Id:` line in the body above the trailer block is not one, exactly
 * as the host reads it. When a message carries several, the last one counts,
 * which is the one Gerrit's commit-msg hook keeps.
 */

const CHANGE_ID_RE = /^I[0-9a-f]{40}$/;
const CHANGE_ID_TRAILER_RE = /^change-id:\s*(\S+)\s*$/i;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// A stack longer than this is read from its top; `truncated` says so.
export const CHANGE_STACK_LIMIT = 50;

const invalidInput = (message) => Object.assign(new Error(message), { code: 'INVALID_GIT_REF', status: 400 });

/** A ref-like argument Git must not read as an option or a range. */
const refArgument = (value, name) => {
  const text = isString(value) ? value.trim() : '';
  if (!text || text.startsWith('-') || text.includes('..') || /[\0-\x20\x7f~^:?*[\\]/.test(text) || text.length > 1024) {
    throw invalidInput(`${name} is invalid`);
  }
  return text;
};

/** `git <args>` in `directory`, with `input` on stdin; stdout, or a rejection on any failure. */
export const runGit = (directory, args, { input = '', env = {} } = {}) => new Promise((resolve, reject) => {
  const child = execFile('git', args, {
    cwd: directory,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', ...env },
  }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});

/** The last valid `Change-Id` trailer of a commit message, or null. */
async function changeIdOfMessage(directory, message, git) {
  const trailers = await git(directory, ['interpret-trailers', '--parse', '--no-divider'], { input: message });
  let changeId = null;
  for (const line of trailers.split('\n')) {
    const match = CHANGE_ID_TRAILER_RE.exec(line.replace(/\r$/, ''));
    if (match && CHANGE_ID_RE.test(match[1])) changeId = match[1];
  }
  return changeId;
}

/** Whether a ref exists; a Git failure other than "no such ref" still rejects. */
const refExists = async (directory, ref, git) => {
  try {
    await git(directory, ['rev-parse', '-q', '--verify', '--end-of-options', ref]);
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
};

/**
 * The commit a local branch points at, or null when there is no such branch
 * or Git cannot read it. Cheap (one `rev-parse`), for keying a cached answer
 * that was derived from the tip.
 */
export async function readBranchTip(directory, branch, { git = runGit } = {}) {
  try {
    const sha = (await git(directory, ['rev-parse', '-q', '--verify', '--end-of-options', `refs/heads/${refArgument(branch, 'branch')}^{commit}`])).trim();
    return SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * `head`: the branch tip and its Change-Id (null when it has none).
 * `stack`: with a `base`, the commits in `base..branch`, oldest first, each
 * with its Change-Id; at most `CHANGE_STACK_LIMIT`, the ones nearest the
 * tip, with `truncated` when more were there. Without a base it is empty.
 * A Git failure (a missing branch or base) rejects; it never reads as a
 * branch without Change-Ids.
 */
export async function readBranchChangeIds(directory, branch, base = null, { git = runGit } = {}) {
  const branchRef = `refs/heads/${refArgument(branch, 'branch')}`;
  const baseRef = base === null ? null : refArgument(base, 'base');
  if (!(await refExists(directory, `${branchRef}^{commit}`, git))) {
    throw Object.assign(new Error(`Branch ${branch} does not exist`), { code: 'GIT_BRANCH_NOT_FOUND', status: 404 });
  }
  const sha = (await git(directory, ['rev-parse', '--verify', '--end-of-options', `${branchRef}^{commit}`])).trim();
  if (!SHA_RE.test(sha)) throw invalidInput('branch does not name a commit');

  let commits = [];
  let truncated = false;
  if (baseRef) {
    const listed = await git(directory, [
      'log', '-z', `--max-count=${CHANGE_STACK_LIMIT + 1}`, '--format=%H%n%B', '--end-of-options', `${baseRef}..${sha}`,
    ]);
    commits = listed.split('\0').filter((record) => record.trim()).map((record) => {
      const newline = record.indexOf('\n');
      return { sha: record.slice(0, newline < 0 ? record.length : newline).trim(), message: newline < 0 ? '' : record.slice(newline + 1) };
    });
    truncated = commits.length > CHANGE_STACK_LIMIT;
    commits = commits.slice(0, CHANGE_STACK_LIMIT).reverse();
  }
  const stack = await Promise.all(commits.map(async (commit) => ({
    sha: commit.sha,
    changeId: await changeIdOfMessage(directory, commit.message, git),
  })));
  const tip = stack.at(-1);
  const head = tip?.sha === sha
    ? tip
    : { sha, changeId: await changeIdOfMessage(directory, await git(directory, ['log', '-1', '--format=%B', sha]), git) };
  return { head, stack, truncated };
}

const refused = (message, code, status = 409) => Object.assign(new Error(message), { code, status });

// Left behind while a cherry-pick, revert, rebase or `git am` is stopped.
const SEQUENCE_STATE = ['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];

/** Whether Git is in the middle of one of those, read from the paths Git itself reports. */
const sequenceInProgress = async (directory, git) => {
  // Each path is relative to `directory` unless Git answers an absolute one (a linked worktree).
  const paths = (await git(directory, ['rev-parse', ...SEQUENCE_STATE.flatMap((name) => ['--git-path', name])]))
    .split('\n').map((line) => line.trim()).filter(Boolean);
  if (paths.length !== SEQUENCE_STATE.length) throw refused('Git could not read the repository state', 'CHANGE_ID_FAILED', 500);
  return paths.some((statePath) => fs.existsSync(path.resolve(directory, statePath)));
};

/**
 * Gives the checked-out commit a `Change-Id` trailer, the way a review host's
 * commit-msg hook would have: `I` plus the SHA-1 Git computes for a blob of
 * the commit's tree, parents, author, committer and message. Nothing is
 * downloaded from the host.
 *
 * Refused (409) unless HEAD is a branch at `expectedHead`, the working tree
 * and index have no tracked changes, no merge, cherry-pick, revert, rebase or
 * `git am` is in progress (each can stop with HEAD on the branch and a clean
 * tree, and would then carry on from a tip that is gone), and HEAD has no
 * Change-Id yet. The commit is rebuilt with its tree, parents and author
 * (`git commit-tree`) and the branch moves only if it still points at
 * `expectedHead` (`git update-ref` compare-and-swap), so a commit made in
 * between is never lost. As with `git commit --amend`, the committer becomes
 * the current user; unlike it, a GPG signature on the old commit is dropped
 * (the new one is signed only when `commit.gpgSign` says so). Answers
 * `{ sha, changeId, branch }`.
 */
export async function addChangeIdToHead(directory, expectedHead, { git = runGit } = {}) {
  const expected = isString(expectedHead) ? expectedHead.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(expected)) throw refused('expectedHead must be a full commit SHA', 'INVALID_REQUEST', 400);
  let branchRef;
  try {
    branchRef = (await git(directory, ['symbolic-ref', '-q', 'HEAD'])).trim();
  } catch {
    throw refused('HEAD is not on a branch', 'DETACHED_HEAD');
  }
  if (!branchRef.startsWith('refs/heads/')) throw refused('HEAD is not on a branch', 'DETACHED_HEAD');
  const head = (await git(directory, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (head !== expected) throw refused('HEAD moved; nothing was changed', 'STALE_HEAD');
  if ((await git(directory, ['status', '--porcelain=v1', '--untracked-files=no'])).trim()) {
    throw refused('Commit or stash your changes first; nothing was changed', 'DIRTY_WORKTREE');
  }
  if (await refExists(directory, 'MERGE_HEAD', git)) throw refused('A merge is in progress; nothing was changed', 'MERGE_IN_PROGRESS');
  if (await sequenceInProgress(directory, git)) {
    throw refused('A cherry-pick, revert, rebase or patch series is in progress; nothing was changed', 'OPERATION_IN_PROGRESS');
  }

  const message = await git(directory, ['log', '-1', '--format=%B', head]);
  if (await changeIdOfMessage(directory, message, git)) throw refused('This commit already has a Change-Id', 'CHANGE_ID_PRESENT');
  const tree = (await git(directory, ['rev-parse', '--verify', `${head}^{tree}`])).trim();
  const parents = (await git(directory, ['log', '-1', '--format=%P', head])).trim().split(/\s+/).filter(Boolean);
  const [authorName, authorEmail, authorDate] = (await git(directory, ['log', '-1', '--format=%an%x00%ae%x00%ad', '--date=raw', head]))
    .replace(/\n$/, '').split('\0');
  const author = `${authorName} <${authorEmail}> ${authorDate}`;
  const committer = (await git(directory, ['var', 'GIT_COMMITTER_IDENT'])).trim();
  const hookInput = [`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`), `author ${author}`, `committer ${committer}`, '', message].join('\n');
  const changeId = `I${(await git(directory, ['hash-object', '-t', 'blob', '--stdin'], { input: hookInput })).trim()}`;
  if (!CHANGE_ID_RE.test(changeId)) throw refused('Git could not compute a Change-Id', 'CHANGE_ID_FAILED', 500);

  const amended = await git(directory, ['interpret-trailers', '--no-divider', '--trailer', `Change-Id: ${changeId}`], { input: message });
  if (await changeIdOfMessage(directory, amended, git) !== changeId) throw refused('Git could not add the trailer', 'CHANGE_ID_FAILED', 500);
  const sha = (await git(directory, ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent])], {
    input: amended,
    env: { GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_AUTHOR_DATE: authorDate },
  })).trim();
  if (!SHA_RE.test(sha)) throw refused('Git could not write the commit', 'CHANGE_ID_FAILED', 500);
  try {
    await git(directory, ['update-ref', '-m', 'commit (amend): add Change-Id', branchRef, sha, head]);
  } catch {
    throw refused('HEAD moved; nothing was changed', 'STALE_HEAD');
  }
  return { sha, changeId, branch: branchRef.slice('refs/heads/'.length) };
}

