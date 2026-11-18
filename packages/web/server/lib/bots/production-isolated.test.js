import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { botGit, advanceBotCheckout } from './production-git.js';
import { readBotGitSnapshot } from './services/git.js';
import { commitFiles } from './production-test-support.js';
import { isolatedProductionFixture } from './production-isolated-test-support.js';

let fixture;
afterEach(async () => { await fixture?.close(); fixture = null; });
const setup = async () => { fixture = await isolatedProductionFixture(); return fixture; };
const ownerRecord = async (f) => JSON.parse(await fs.readFile(`${f.checkout.directory}.json`, 'utf8'));

describe('isolated result adoption through real code-out quarantine and Git', () => {
  test('adopts files, index and bot ref; inspect/proof inputs and publication retain exact commits', async () => {
    const f = await setup();
    await fs.writeFile(path.join(f.directory, 'user-work'), 'untouched user data');
    const expected = await f.correction();
    const exported = await f.exportSnapshot();
    expect((await botGit(f.item.worktree, ['rev-parse', 'HEAD'])).trim()).toBe(f.base);
    expect(await f.makeWorktrees().adoptIsolated({ ...f.request, resultSha: exported.resultSha })).toEqual({ headSha: expected.fixSha });
    const snapshot = await f.makeWorktrees().inspect(f.request);
    expect(snapshot).toMatchObject({ headSha: expected.fixSha, testSha: expected.testSha, fixSha: expected.fixSha, testFiles: ['regression.test.mjs'] });
    expect(await fs.readFile(path.join(f.item.worktree, 'old.js'), 'utf8')).toContain('value = 2');
    expect((await botGit(f.item.worktree, ['write-tree'])).trim()).toBe((await botGit(f.inside, ['rev-parse', 'HEAD^{tree}'])).trim());
    const published = await readBotGitSnapshot({ directory: f.item.worktree, branch: f.item.branch, headSha: snapshot.headSha, baseSha: f.base });
    expect(published.commits.map((commit) => commit.sourceSha)).toEqual([expected.testSha, expected.fixSha]);
    expect(await f.makeWorktrees().adoptIsolated({ ...f.request, resultSha: exported.resultSha })).toEqual({ headSha: expected.fixSha });
    expect(await fs.readFile(path.join(f.directory, 'user-work'), 'utf8')).toBe('untouched user data');
    expect((await botGit(f.directory, ['rev-parse', 'HEAD'])).trim()).toBe(f.base);
    expect((await ownerRecord(f)).state).toBe('ready');
  });

  test('host execution bait is live in ordinary Git and stays inert throughout adoption and inspection', async () => {
    const f = await setup();
    await commitFiles(f.inside, { '.gitattributes': '*.payload filter=host-bait\n', 'result.payload': 'untrusted data\n' }, 'Attributes from inside');
    const exported = await f.exportSnapshot();
    const marker = await f.plantHostExecutionBait();
    await f.makeWorktrees().adoptIsolated({ ...f.request, resultSha: exported.resultSha });
    await f.makeWorktrees().inspect(f.request);
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(f.item.worktree, 'result.payload'), 'utf8')).toBe('untrusted data\n');
  });

  test('durable intent precedes file mutation and restart finishes a completed index without replaying checkout', async () => {
    const f = await setup();
    const expected = await f.correction();
    const exported = await f.exportSnapshot();
    const interrupted = f.makeWorktrees({ advanceCheckout: async (input) => {
      expect(await ownerRecord(f)).toMatchObject({ state: 'adopting', adoption: { fromSha: f.base, resultSha: expected.fixSha } });
      await advanceBotCheckout(input);
      throw new Error('Simulated process interruption after file mutation');
    } });
    await expect(interrupted.adoptIsolated({ ...f.request, resultSha: exported.resultSha })).rejects.toThrow('Simulated process interruption');
    await expect(f.makeWorktrees().inspect(f.request)).rejects.toMatchObject({ code: 'BOT_WORKTREE_CREATE_UNSETTLED' });
    expect((await botGit(f.item.worktree, ['rev-parse', 'HEAD'])).trim()).toBe(expected.fixSha);
    expect((await botGit(f.item.worktree, ['rev-parse', `refs/heads/${f.item.branch}`])).trim()).toBe(f.base);
    const restarted = f.makeWorktrees({ advanceCheckout: async () => { throw new Error('Completed checkout must not repeat'); } });
    expect(await restarted.adoptIsolated({ ...f.request, resultSha: exported.resultSha })).toEqual({ headSha: expected.fixSha });
    expect((await f.makeWorktrees().inspect(f.request)).headSha).toBe(expected.fixSha);
  });

  test('a partial write stays blocked across restart and preserves newer user data', async () => {
    const f = await setup();
    await f.correction();
    const exported = await f.exportSnapshot();
    const interrupted = f.makeWorktrees({ advanceCheckout: async () => {
      await fs.writeFile(path.join(f.item.worktree, 'old.js'), 'newer user data\n');
      throw new Error('Simulated partial write');
    } });
    await expect(interrupted.adoptIsolated({ ...f.request, resultSha: exported.resultSha })).rejects.toThrow('Simulated partial write');
    await expect(f.makeWorktrees().adoptIsolated({ ...f.request, resultSha: exported.resultSha })).rejects.toMatchObject({ code: 'BOT_ISOLATED_ADOPTION_UNSETTLED' });
    await expect(f.makeWorktrees().remove(f.request)).rejects.toMatchObject({ code: 'BOT_WORKTREE_CREATE_UNSETTLED' });
    expect(await fs.readFile(path.join(f.item.worktree, 'old.js'), 'utf8')).toBe('newer user data\n');
    expect((await botGit(f.item.worktree, ['rev-parse', 'HEAD'])).trim()).toBe(f.base);
  });

  test('dirty paths and hidden index edits refuse adoption', async () => {
    const f = await setup();
    await f.correction();
    const exported = await f.exportSnapshot();
    await fs.writeFile(path.join(f.item.worktree, 'untracked'), 'keep');
    await expect(f.makeWorktrees().adoptIsolated({ ...f.request, resultSha: exported.resultSha })).rejects.toMatchObject({ code: 'BOT_WORKTREE_DIRTY' });
    await fs.rm(path.join(f.item.worktree, 'untracked'));
    await botGit(f.item.worktree, ['update-index', '--assume-unchanged', 'old.js']);
    await fs.writeFile(path.join(f.item.worktree, 'old.js'), 'hidden user change');
    await expect(f.makeWorktrees().adoptIsolated({ ...f.request, resultSha: exported.resultSha })).rejects.toMatchObject({ code: 'BOT_ISOLATED_INDEX_FLAGS' });
    expect(await fs.readFile(path.join(f.item.worktree, 'old.js'), 'utf8')).toBe('hidden user change');
  });

  test('ignored user data arriving after admission is not overwritten by Git population', async () => {
    const f = await setup();
    await commitFiles(f.inside, { '.gitignore': 'conflict.out\n' }, 'Ignore generated files');
    const first = await f.exportSnapshot();
    await f.makeWorktrees().adoptIsolated({ ...f.request, resultSha: first.resultSha });
    await fs.writeFile(path.join(f.inside, 'conflict.out'), 'space data\n');
    await botGit(f.inside, ['add', '--force', 'conflict.out']);
    await botGit(f.inside, ['commit', '-m', 'Space adds ignored path']);
    const exported = await f.exportSnapshot();
    const racing = f.makeWorktrees({ advanceCheckout: async (input) => {
      await fs.writeFile(path.join(f.item.worktree, 'conflict.out'), 'new user data\n');
      return advanceBotCheckout(input);
    } });
    await expect(racing.adoptIsolated({ ...f.request, resultSha: exported.resultSha })).rejects.toMatchObject({ code: 'BOT_GIT_LOCAL_FAILED' });
    expect(await fs.readFile(path.join(f.item.worktree, 'conflict.out'), 'utf8')).toBe('new user data\n');
    expect((await botGit(f.item.worktree, ['rev-parse', 'HEAD'])).trim()).toBe(first.resultSha);
  });

  test('divergent clean host commits and unpromoted local objects grant no transfer authority', async () => {
    const f = await setup();
    await f.correction();
    const exported = await f.exportSnapshot();
    const own = await commitFiles(f.item.worktree, { 'host-only': 'keep committed user work\n' }, 'New host work');
    await expect(f.makeWorktrees().adoptIsolated({ ...f.request, resultSha: exported.resultSha })).rejects.toMatchObject({ code: 'BOT_ISOLATED_ANCESTRY' });
    expect((await botGit(f.item.worktree, ['rev-parse', 'HEAD'])).trim()).toBe(own);
    await botGit(f.item.worktree, ['update-ref', '-d', `refs/openchamber/spaces/${f.spaceId}/result`, exported.resultSha]);
    await expect(f.makeWorktrees().adoptIsolated({ ...f.request, resultSha: own })).rejects.toMatchObject({ code: 'BOT_ISOLATED_RESULT_NOT_PROMOTED' });
    expect((await ownerRecord(f)).state).toBe('ready');
  });

  test('shared code-out path guards honor Git boolean spelling and refuse case-only names', async () => {
    const f = await setup();
    await botGit(f.inside, ['mv', 'old.js', 'OLD.js']);
    await botGit(f.inside, ['commit', '-m', 'Case-only rename']);
    const exported = await f.exportSnapshot();
    await botGit(f.item.worktree, ['config', 'core.ignorecase', 'yes']);
    await expect(f.makeWorktrees().adoptIsolated({ ...f.request, resultSha: exported.resultSha })).rejects.toMatchObject({ code: 'BOT_ISOLATED_PATH_UNSAFE' });
    expect((await botGit(f.item.worktree, ['rev-parse', 'HEAD'])).trim()).toBe(f.base);
    expect(await fs.readFile(path.join(f.item.worktree, 'old.js'), 'utf8')).toContain('value = 1');
  });
});
