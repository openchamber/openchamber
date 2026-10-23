import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { productionFixture, commitFiles } from './production-test-support.js';
import { botGit } from './production-git.js';

let fixture;
afterEach(async () => { await fixture?.close(); fixture = null; });
const setup = async () => { fixture = await productionFixture(); return fixture; };
const create = async (f) => {
  const checkout = await f.makeWorktrees().create(f.request);
  Object.assign(f.item, { worktree: checkout.directory, branch: checkout.branch });
  return checkout;
};

describe('production bot worktrees with real Git owners', () => {
  test('create, immutable inspect, restart reconciliation and owned cleanup preserve the user checkout', async () => {
    const f = await setup();
    await botGit(f.directory, ['checkout', '-b', 'unrelated']);
    await fs.writeFile(path.join(f.directory, 'user-work.txt'), 'uncommitted user work');
    const checkout = await create(f);
    expect(checkout).toMatchObject({ branch: 'bot/item-1', baseBranch: 'main', baseSha: f.base });
    expect((await botGit(checkout.directory, ['config', '--worktree', 'user.email'])).trim()).toBe('42+selected-bot@users.noreply.github.com');
    expect((await botGit(f.directory, ['config', '--local', 'user.email'])).trim()).toBe('owner@example.test');
    const testSha = await commitFiles(checkout.directory, { 'value.test.js': 'test("regression", () => {});\n' }, 'Regression test');
    await botGit(checkout.directory, ['mv', 'old.js', 'new.js']);
    const fixSha = await commitFiles(checkout.directory, { 'fix.js': 'export const fixed = true;\n' }, 'Correction');
    const snapshot = await f.makeWorktrees().inspect(f.request);
    expect(snapshot).toMatchObject({ headSha: fixSha, baseSha: f.base, testSha, fixSha, testFiles: ['value.test.js'], remoteSha: null });
    expect(snapshot.changes).toContainEqual({ oldPath: 'old.js', newPath: 'new.js' });
    snapshot.changes.length = 0;
    expect((await f.makeWorktrees().inspect(f.request)).changes.length).toBeGreaterThan(0);
    expect(await f.makeWorktrees().reconcile(f.request)).toEqual({ state: 'succeeded', result: checkout });
    await f.makeWorktrees().remove({ ...f.request, key: undefined, checkout });
    expect(await f.makeWorktrees().reconcile({ ...f.request, key: undefined, operation: 'remove', checkout })).toEqual({ state: 'succeeded', result: { id: f.item.id } });
    expect((await botGit(f.directory, ['branch', '--show-current'])).trim()).toBe('unrelated');
    expect(await fs.readFile(path.join(f.directory, 'user-work.txt'), 'utf8')).toBe('uncommitted user work');
  });

  test('refuses unowned branches, paths, dirty and ignored files and unsettled effects', async () => {
    const f = await setup();
    await botGit(f.directory, ['branch', 'bot/item-1']);
    await expect(f.makeWorktrees().create(f.request)).rejects.toMatchObject({ code: 'BOT_WORKTREE_UNOWNED' });
    await botGit(f.directory, ['branch', '-D', 'bot/item-1']);
    const checkout = await create(f);
    await fs.writeFile(path.join(checkout.directory, 'untracked'), 'keep');
    await expect(f.makeWorktrees().remove(f.request)).rejects.toMatchObject({ code: 'BOT_WORKTREE_DIRTY' });
    await fs.rm(path.join(checkout.directory, 'untracked'));
    f.item.effects.push({ key: 'external', kind: 'git.push', state: 'outcome-unknown' });
    await expect(f.makeWorktrees().remove(f.request)).rejects.toMatchObject({ code: 'BOT_WORKTREE_UNSETTLED_EFFECTS' });
    f.item.effects.length = 0;
    await expect(f.makeWorktrees().remove({ ...f.request, item: { ...f.item, worktree: f.directory } })).rejects.toMatchObject({ code: 'BOT_WORKTREE_OWNERSHIP' });
    await f.makeWorktrees().remove(f.request);
  });

  test('the final Git-owner deletion check cannot be swallowed as best-effort disposal', async () => {
    const f = await setup();
    const checkout = await create(f);
    const worktrees = f.makeWorktrees({ disposeInstance: async () => {
      await fs.writeFile(path.join(checkout.directory, 'arrived-during-disposal'), 'keep');
    } });
    await expect(worktrees.remove(f.request)).rejects.toMatchObject({ code: 'BOT_WORKTREE_DIRTY' });
    expect(await fs.readFile(path.join(checkout.directory, 'arrived-during-disposal'), 'utf8')).toBe('keep');
  });

  test('ignored build artifacts do not alter immutable inspection and are retained by cleanup refusal', async () => {
    const f = await setup();
    const checkout = await create(f);
    await commitFiles(checkout.directory, { '.gitignore': 'build-output\n' }, 'Ignore generated output');
    await fs.writeFile(path.join(checkout.directory, 'build-output'), 'retained build data');
    expect((await f.makeWorktrees().inspect(f.request)).changes).toContainEqual({ newPath: '.gitignore' });
    await expect(f.makeWorktrees().remove(f.request)).rejects.toMatchObject({ code: 'BOT_WORKTREE_DIRTY' });
    expect(await fs.readFile(path.join(checkout.directory, 'build-output'), 'utf8')).toBe('retained build data');
  });

  test('provider failures are errors and never a missing remote or empty snapshot', async () => {
    const f = await setup();
    await create(f);
    f.state.failReads = true;
    await expect(f.makeWorktrees().inspect(f.request)).rejects.toMatchObject({ code: 'BOT_SERVICE_REJECTED' });
  });

  test('a changed selected identity cannot reuse the original author or prevent local cleanup', async () => {
    const f = await setup();
    await create(f);
    await f.selectApp();
    await expect(f.makeWorktrees().inspect(f.request)).rejects.toMatchObject({ code: 'BOT_IDENTITY_CHANGED' });
    await f.makeWorktrees().remove(f.request);
    expect((await f.makeWorktrees().reconcile({ ...f.request, operation: 'remove' })).state).toBe('succeeded');
  });

  test('signed commit-map adoption verifies provider objects, exact tree, full linear history and retry', async () => {
    const f = await setup();
    await f.selectApp();
    const checkout = await create(f);
    const regression = await commitFiles(checkout.directory, { 'fixed.test.js': 'regression\n' }, 'Signed regression');
    const source = await commitFiles(checkout.directory, { 'fixed.js': 'fixed\n' }, 'Signed correction');
    const snapshot = await f.makeWorktrees().inspect(f.request);
    const signature = '-----BEGIN PGP SIGNATURE-----\ncontrolled-provider-signature\n-----END PGP SIGNATURE-----';
    const commitMap = [];
    let publishedParent = f.base;
    for (const sourceSha of [regression, source]) {
      const original = await botGit(checkout.directory, ['cat-file', 'commit', sourceSha]);
      const split = original.indexOf('\n\n');
      const headers = original.slice(0, split).split('\n').map((line) => line.startsWith('parent ') ? `parent ${publishedParent}`
        : line.startsWith('author ') || line.startsWith('committer ') ? line.replace('selected-app[bot]', 'github-signer') : line).join('\n');
      const payload = headers + original.slice(split);
      const signed = `${headers}\ngpgsig ${signature.replace(/\n/g, '\n ')}${original.slice(split)}`;
      const publishedSha = (await botGit(checkout.directory, ['hash-object', '-t', 'commit', '--stdin'], signed)).trim();
      f.state.signed.set(publishedSha, { sha: publishedSha, tree: { sha: headers.split('\n')[0].slice(5) }, parents: [{ sha: publishedParent }],
        message: original.slice(split + 2).replace(/\n$/, ''), verification: { verified: true, payload, signature } });
      commitMap.push({ sourceSha, publishedSha });
      publishedParent = publishedSha;
    }
    const published = publishedParent;
    f.state.remote = published;
    const result = { headSha: published, sourceHeadSha: source, commitMap };
    await expect(f.makeWorktrees().acceptPublished({ ...f.request, snapshot, result: { ...result, commitMap: commitMap.slice(1) } }))
      .rejects.toMatchObject({ code: 'BOT_GIT_COMMIT_MAP_INVALID' });
    expect((await botGit(checkout.directory, ['rev-parse', 'HEAD'])).trim()).toBe(source);
    await f.makeWorktrees().acceptPublished({ ...f.request, snapshot, result });
    expect((await botGit(checkout.directory, ['rev-parse', 'HEAD'])).trim()).toBe(published);
    expect((await botGit(checkout.directory, ['status', '--porcelain'])).trim()).toBe('');
    await f.makeWorktrees().acceptPublished({ ...f.request, snapshot, result });
    f.state.signed.get(published).verification.verified = false;
    await expect(f.makeWorktrees().acceptPublished({ ...f.request, snapshot, result })).rejects.toMatchObject({ code: 'BOT_SERVICE_RESPONSE_INVALID' });
  });
});
