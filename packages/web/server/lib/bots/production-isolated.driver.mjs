import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProductionBotWorktrees } from './production-worktrees.js';
import { advanceBotCheckout, botGit } from './production-git.js';
import { isolatedProductionFixture } from './production-isolated-test-support.js';
import { commitFiles } from './production-test-support.js';
import { createBotProofRunner } from './proof.js';
import { BOT_ISOLATED_PROOF_PROGRAM } from './isolated-stages.js';
import { readBotGitSnapshot } from './services/git.js';
import { runCommand } from '../spaces/run-command.js';

/** Same behavioral probe is used by the normal driver and disposable mutants. */
export async function runAdoptionProbe({ createWorktrees = createProductionBotWorktrees, advanceCheckout = advanceBotCheckout } = {}) {
  const f = await isolatedProductionFixture();
  try {
    const { testSha } = await f.correction();
    await commitFiles(f.inside, { '.gitattributes': '*.payload filter=host-bait\n', 'result.payload': 'inside content\n' }, 'Inside attributes');
    const exported = await f.exportSnapshot();
    const marker = await f.plantHostExecutionBait();
    let intentChecks = 0;
    const worktrees = createWorktrees({ dataDir: f.dataDir, context: f.context, readItem: async () => f.item,
      advanceCheckout: async (input) => {
        const record = JSON.parse(await fs.readFile(`${f.item.worktree}.json`, 'utf8'));
        assert.equal(record.state, 'adopting', 'Adoption intent must be durable before checkout');
        assert.equal(record.adoption.resultSha, exported.resultSha);
        intentChecks += 1;
        return advanceCheckout(input);
      } });
    await worktrees.adoptIsolated({ ...f.request, resultSha: exported.resultSha });
    assert.equal(intentChecks, 1);
    const snapshot = await worktrees.inspect(f.request);
    assert.equal(snapshot.testSha, testSha);
    assert.equal(snapshot.fixSha, exported.resultSha);
    assert.equal((await botGit(f.item.worktree, ['symbolic-ref', 'HEAD'])).trim(), `refs/heads/${f.item.branch}`);
    await assert.rejects(fs.lstat(marker), { code: 'ENOENT' }, 'Imported attributes must not execute a host filter');
    const publication = await readBotGitSnapshot({ directory: f.item.worktree, branch: f.item.branch, headSha: snapshot.headSha, baseSha: f.base });
    const proof = createBotProofRunner({ root: path.join(f.root, 'proof'), executeIsolatedProof: async (input) => {
      // A local source stand-in runs the actual isolated proof program. This
      // validates the commit handoff, and is not evidence of Docker isolation.
      assert.equal(input.isolated, true);
      const result = await runCommand(process.execPath, ['-e', BOT_ISOLATED_PROOF_PROGRAM], {
        stdin: JSON.stringify({ ...input, directory: f.inside }), timeoutMs: 330_000,
        env: { PATH: process.env.PATH, HOME: f.root, GIT_MASTER: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
      assert.equal(result.code, 0);
      return JSON.parse(result.stdout);
    } });
    const result = await proof.run({ directory: f.item.worktree, testSha, fixSha: snapshot.fixSha,
      command: process.execPath, args: ['regression.test.mjs'], isolated: true });
    assert.equal(result.status, 'passed');
    assert.equal(result.testExitCode, 1);
    assert.equal(result.fixExitCode, 0);
    await worktrees.remove(f.request);
    return { transfer: 'real code-out quarantine with local upload-pack stand-in', adoptedSha: snapshot.headSha,
      proof: { testExitCode: result.testExitCode, fixExitCode: result.fixExitCode }, publicationCommits: publication.commits.length,
      cleanup: 'owned checkout removed', boundary: 'No Docker isolation or live provider publication claimed' };
  } finally { await f.close(); }
}

export async function runIgnoredRaceProbe({ createWorktrees = createProductionBotWorktrees, advanceCheckout = advanceBotCheckout } = {}) {
  const f = await isolatedProductionFixture();
  try {
    await commitFiles(f.inside, { '.gitignore': 'conflict.out\n' }, 'Ignore output');
    const initial = await f.exportSnapshot();
    await f.makeWorktrees().adoptIsolated({ ...f.request, resultSha: initial.resultSha });
    await fs.writeFile(path.join(f.inside, 'conflict.out'), 'space data\n');
    await botGit(f.inside, ['add', '--force', 'conflict.out']);
    await botGit(f.inside, ['commit', '-m', 'Add output']);
    const exported = await f.exportSnapshot();
    const worktrees = createWorktrees({ dataDir: f.dataDir, context: f.context, readItem: async () => f.item,
      advanceCheckout: async (input) => {
        await fs.writeFile(path.join(f.item.worktree, 'conflict.out'), 'late user data\n');
        return advanceCheckout(input);
      } });
    await assert.rejects(worktrees.adoptIsolated({ ...f.request, resultSha: exported.resultSha }),
      { code: 'BOT_GIT_LOCAL_FAILED' }, 'Late ignored user data must refuse checkout');
    assert.equal(await fs.readFile(path.join(f.item.worktree, 'conflict.out'), 'utf8'), 'late user data\n');
  } finally { await f.close(); }
}

export async function runAncestryProbe({ createWorktrees = createProductionBotWorktrees } = {}) {
  const f = await isolatedProductionFixture();
  try {
    await f.correction();
    const exported = await f.exportSnapshot();
    await commitFiles(f.item.worktree, { 'user-commit': 'retain committed work\n' }, 'User work');
    const worktrees = createWorktrees({ dataDir: f.dataDir, context: f.context, readItem: async () => f.item });
    await assert.rejects(worktrees.adoptIsolated({ ...f.request, resultSha: exported.resultSha }),
      { code: 'BOT_ISOLATED_ANCESTRY' }, 'A divergent result must preserve the current bot head');
  } finally { await f.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runAdoptionProbe(), null, 2));
}
