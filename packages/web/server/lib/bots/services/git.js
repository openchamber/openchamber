import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createGitCredentialBroker } from '../../git/credential-broker.js';
import { resolveRepositoryIdentity } from '../../source-control/repository-identity.js';
import { assertBotWriteAllowed } from '../../enterprise-mode.js';
import { BotServiceError, branch as branchSchema, parse, providerResult, sha, text } from './contracts.js';

const execFileAsync = promisify(execFile);
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const gitEnvironment = () => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  GIT_MASTER: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_LAZY_FETCH: '1' });

async function git(directory, args, encoding = 'utf8') {
  try {
    const result = await execFileAsync('git', ['-c', 'core.hooksPath=', '-c', 'credential.helper=',
      '-c', 'protocol.allow=never', ...args], {
      cwd: directory, env: gitEnvironment(), shell: false, windowsHide: true,
      timeout: 30_000, maxBuffer: MAX_OBJECT_BYTES, encoding,
    });
    return result.stdout;
  } catch { throw new BotServiceError('BOT_GIT_LOCAL_FAILED', 'The bot worktree or local Git objects could not be read.'); }
}

/** Configure only the linked worktree's author. No shared author or transport edits. */
export async function configureBotWorktreeIdentity({ directory, name, email }) {
  parse(text, directory); parse(text, name); parse(text, email);
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email)) throw new BotServiceError('BOT_GIT_AUTHOR_INVALID', 'A valid bot author email is required.', 'failed', 400);
  const paths = (await git(directory, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])).trim().split(/\r?\n/);
  if (paths.length !== 2 || await fs.realpath(paths[0]) === await fs.realpath(paths[1])) {
    throw new BotServiceError('BOT_GIT_WORKTREE_REQUIRED', 'Bot author configuration requires a linked worktree.');
  }
  // Enabling worktree config with these common values requires a separate migration.
  // Refuse rather than changing the primary checkout's core configuration.
  const commonConfig = await git(directory, ['config', '--local', '--list']);
  if (/^core\.(?:worktree|bare)=/mi.test(commonConfig)) {
    const bare = commonConfig.match(/^core\.bare=(.*)$/mi)?.[1];
    if (bare !== 'false' || /^core\.worktree=/mi.test(commonConfig)) {
      throw new BotServiceError('BOT_GIT_WORKTREE_CONFIG_UNSUPPORTED', 'This repository needs worktree configuration migration before a bot can set its author.');
    }
  }
  await git(directory, ['config', '--local', 'extensions.worktreeConfig', 'true']);
  await git(directory, ['config', '--worktree', 'user.name', name]);
  await git(directory, ['config', '--worktree', 'user.email', email]);
  await git(directory, ['config', '--worktree', 'commit.gpgsign', 'false']);
  return { name, email };
}

export async function readBotGitSnapshot({ directory, branch, headSha, baseSha }) {
  parse(text, directory); parse(branchSchema, branch); parse(sha, headSha); parse(sha, baseSha);
  const actual = (await git(directory, ['rev-parse', '--verify', `refs/heads/${branch}`])).trim();
  if (actual !== headSha) throw new BotServiceError('BOT_GIT_HEAD_CHANGED', 'The bot branch changed after publication was prepared.');
  const commits = (await git(directory, ['rev-list', '--reverse', '--topo-order', '--max-count=101', headSha, `^${baseSha}`])).trim().split(/\r?\n/).filter(Boolean);
  if (!commits.length || commits.length > 100) throw new BotServiceError('BOT_GIT_COMMIT_LIMIT', 'Publish between 1 and 100 bot commits at a time.');
  let expectedParent = baseSha;
  let totalBytes = 0;
  const snapshots = [];
  for (const commitSha of commits) {
    parse(sha, commitSha);
    const raw = await git(directory, ['cat-file', 'commit', commitSha]);
    const separator = raw.indexOf('\n\n');
    const headers = raw.slice(0, separator).split('\n');
    const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
    if (parents.length !== 1 || parents[0] !== expectedParent) throw new BotServiceError('BOT_GIT_LINEAR_HISTORY_REQUIRED', 'Bot publication requires a linear history from the selected base.');
    const treeSha = headers.find((line) => line.startsWith('tree '))?.slice(5);
    parse(sha, treeSha);
    const listing = await git(directory, ['ls-tree', '-rz', treeSha]);
    const entries = listing.split('\0').filter(Boolean);
    if (entries.length > 2_000) throw new BotServiceError('BOT_GIT_TREE_LIMIT', 'The bot snapshot exceeds the publication file limit.');
    const files = [];
    for (const entry of entries) {
      const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
      if (!match) throw new BotServiceError('BOT_GIT_OBJECT_UNSUPPORTED', 'Bot publication does not support submodule changes.');
      const [, mode, blobSha, filePath] = match;
      if (filePath.split('/').some((part) => part === '.git' || part === '..') || path.posix.isAbsolute(filePath)) {
        throw new BotServiceError('BOT_GIT_PATH_INVALID', 'The bot snapshot contains an invalid path.');
      }
      const content = await git(directory, ['cat-file', 'blob', blobSha], 'buffer');
      totalBytes += content.length;
      if (totalBytes > MAX_OBJECT_BYTES) throw new BotServiceError('BOT_GIT_OBJECT_LIMIT', 'The bot publication exceeds 16 MiB.');
      if (content.subarray(0, 100).toString().startsWith('version https://git-lfs.github.com/spec/v1')) {
        throw new BotServiceError('BOT_GIT_LFS_UNSUPPORTED', 'Bot publication needs an explicit LFS transfer before this snapshot can be sent.');
      }
      files.push({ path: filePath, mode, sha: blobSha, content: content.toString('base64') });
    }
    snapshots.push({ sourceSha: commitSha, treeSha, message: raw.slice(separator + 2), files });
    expectedParent = commitSha;
  }
  const baseTreeSha = (await git(directory, ['rev-parse', `${baseSha}^{tree}`])).trim();
  parse(sha, baseTreeSha);
  return { baseTreeSha, commits: snapshots };
}

export async function publishBotGit({ credential, target, input, readBranch, readRules, root, policyOptions,
  readSnapshot = readBotGitSnapshot, resolveRepository = resolveRepositoryIdentity, pushProcess = execFileAsync,
}) {
  const repository = await resolveRepository(input.directory);
  if (!repository.supported || repository.repositoryId !== target.repositoryId) {
    throw new BotServiceError('BOT_GIT_REPOSITORY_CHANGED', 'The bot worktree belongs to another repository.');
  }
  if (input.branch === input.base) throw new BotServiceError('BOT_GIT_BRANCH_INVALID', 'A bot cannot publish to its base branch.');
  const rules = await readRules(input.base);
  const current = await readBranch(input.branch, true);
  if (current !== input.expectedRemoteSha) throw new BotServiceError('BOT_GIT_REMOTE_CHANGED', 'The bot branch changed on GitHub.');
  const parentSha = current ?? rules.headSha;
  if (!rules.requiredSignatures) {
    if (parentSha !== input.baseSha) throw new BotServiceError('BOT_GIT_BASE_CHANGED', 'The local publication base differs from the remote branch.');
    // Snapshot validation rejects hooks, submodules, lazy fetch and missing LFS transfers.
    await readSnapshot(input);
    return pushUnsigned({ credential, target, input, policyOptions, resolveRepository, pushProcess });
  }
  if (credential.definition.kind !== 'github-app') {
    throw new BotServiceError('BOT_GITHUB_SIGNING_IDENTITY_REQUIRED', 'This branch requires verified signatures. Select a GitHub App identity.');
  }
  const snapshot = await readSnapshot(input);
  const parent = providerResult(z.object({ sha, tree: z.object({ sha }) }),
    await credential.request({ path: `${root}/git/commits/${parentSha}` }));
  if (parent.sha !== parentSha || parent.tree.sha !== snapshot.baseTreeSha) {
    throw new BotServiceError('BOT_GIT_BASE_CHANGED', 'The local and published parent trees differ.');
  }
  const commitMap = [];
  let publishedSha = parentSha;
  for (const commit of snapshot.commits) {
    const tree = [];
    for (const file of commit.files) {
      const blob = providerResult(z.object({ sha }), await credential.request({ path: `${root}/git/blobs`, method: 'POST',
        body: { content: file.content, encoding: 'base64' },
      }), true);
      if (blob.sha !== file.sha) throw new BotServiceError('BOT_GIT_OBJECT_MISMATCH', 'GitHub returned a different blob object.', 'outcome-unknown');
      tree.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha });
    }
    const createdTree = providerResult(z.object({ sha }), await credential.request({ path: `${root}/git/trees`, method: 'POST', body: { tree } }), true);
    if (createdTree.sha !== commit.treeSha) throw new BotServiceError('BOT_GIT_OBJECT_MISMATCH', 'GitHub returned a different tree object.', 'outcome-unknown');
    // GitHub signs App commits only when author, committer and signature overrides are absent.
    const created = providerResult(z.object({ sha, tree: z.object({ sha }), parents: z.array(z.object({ sha })),
      verification: z.object({ verified: z.literal(true) }),
    }), await credential.request({ path: `${root}/git/commits`, method: 'POST',
      body: { tree: createdTree.sha, parents: [publishedSha], message: commit.message },
    }), true);
    if (created.tree.sha !== commit.treeSha || created.parents.length !== 1 || created.parents[0].sha !== publishedSha) {
      throw new BotServiceError('BOT_GIT_OBJECT_MISMATCH', 'The signed GitHub commit differs from the approved snapshot.', 'outcome-unknown');
    }
    publishedSha = created.sha;
    commitMap.push({ sourceSha: commit.sourceSha, publishedSha });
  }
  if (await readBranch(input.branch, true) !== input.expectedRemoteSha) {
    throw new BotServiceError('BOT_GIT_REMOTE_CHANGED', 'The bot branch changed while signed objects were prepared.');
  }
  if (current === null) {
    await credential.request({ path: `${root}/git/refs`, method: 'POST', body: { ref: `refs/heads/${input.branch}`, sha: publishedSha } });
  } else {
    // GitHub's non-forced update rejects a concurrent divergent writer.
    await credential.request({ path: `${root}/git/refs/heads/${encodeURIComponent(input.branch)}`, method: 'PATCH', body: { sha: publishedSha, force: false } });
  }
  return { headSha: publishedSha, sourceHeadSha: input.headSha, commitMap };
}

async function pushUnsigned({ credential, target, input, policyOptions, resolveRepository, pushProcess }) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-bot-push-'));
  const broker = createGitCredentialBroker();
  let grant;
  try {
    await fs.chmod(temporary, 0o700);
    const common = (await git(input.directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    await git(temporary, ['init', '--bare', '--quiet']);
    await broker.start();
    grant = broker.issue({ operationId: randomUUID(), credential: {
      mode: 'managed', transport: 'https', username: 'x-access-token', password: credential.gitToken,
      allowedEndpoint: { protocol: 'https', host: 'github.com', path: `${target.owner}/${target.repo}.git` },
    } });
    const current = await resolveRepository(input.directory);
    if (current.repositoryId !== target.repositoryId
      || (await git(input.directory, ['rev-parse', '--verify', `refs/heads/${input.branch}`])).trim() !== input.headSha) {
      throw new BotServiceError('BOT_GIT_HEAD_CHANGED', 'The bot worktree changed before publication.');
    }
    await credential.assertCurrent();
    try { assertBotWriteAllowed({ service: 'github', origin: 'https://github.com', resource: `${target.owner}/${target.repo}` }, policyOptions); }
    catch { throw new BotServiceError('enterprise_mode', 'Enterprise mode refuses this bot Git push.', 'needs-you', 403); }
    try {
      await pushProcess('git', [...grant.gitConfigArgs, '-c', 'core.hooksPath=', '-c', 'protocol.allow=never',
        '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false', '-c', 'http.extraHeader=',
        'push', '--no-verify', '--porcelain', `--force-with-lease=refs/heads/${input.branch}:${input.expectedRemoteSha ?? ''}`,
        `https://github.com/${target.owner}/${target.repo}.git`, `${input.headSha}:refs/heads/${input.branch}`,
      ], { cwd: temporary, shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024,
        env: { ...gitEnvironment(), ...grant.env, HOME: temporary, USERPROFILE: temporary,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(common, 'objects') },
      });
    } catch { throw new BotServiceError('BOT_GIT_PUSH_UNKNOWN', 'The Git push outcome must be reconciled from GitHub.', 'outcome-unknown', 502); }
    return { headSha: input.headSha, sourceHeadSha: input.headSha };
  } finally {
    grant?.revoke();
    await broker.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
