import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { productionFixture, commitFiles } from './production-test-support.js';
import { botGit } from './production-git.js';
import { BotServiceError } from './services/contracts.js';

let fixture;
afterEach(async () => { await fixture?.close(); fixture = null; });
const setup = async () => { fixture = await productionFixture(); return fixture; };
const create = async (f) => {
  const checkout = await f.makeWorktrees().create(f.request);
  Object.assign(f.item, { worktree: checkout.directory, branch: checkout.branch });
  return checkout;
};
const ownerFile = (f, request = f.request) => path.join(f.dataDir, 'bot-worktrees',
  `${createHash('sha256').update(`${request.project.id}\0${request.item.id}`).digest('hex')}.json`);
const publicationHarness = (f) => {
  const remotes = new Map();
  const reads = [];
  const context = { ...f.context, github: async (request) => {
    const resolved = await f.context.github(request);
    return { ...resolved, credential: { ...resolved.credential, request: async (input) => {
      const match = input.path.match(/^\/repos\/acme\/app\/git\/ref\/heads\/(.+)$/);
      const branch = match && decodeURIComponent(match[1]);
      if (!branch || branch === 'main') return resolved.credential.request(input);
      reads.push(branch);
      if (remotes.has(branch)) return { ref: `refs/heads/${branch}`, object: { sha: remotes.get(branch) } };
      throw new BotServiceError('BOT_SERVICE_REJECTED', 'Controlled missing remote', 'needs-you', 404);
    } } };
  } };
  return { remotes, reads, makeWorktrees: (options) => f.makeWorktrees({ context, ...options }),
    lookup: async () => {
      const record = JSON.parse(await fs.readFile(ownerFile(f), 'utf8'));
      return { repositoryId: record.repositoryId, botId: record.botId, itemId: record.itemId };
    },
    registryFile: async () => path.join(f.dataDir, 'bot-worktrees',
      (await fs.readdir(path.join(f.dataDir, 'bot-worktrees'))).find((name) => name.endsWith('.publications.json'))) };
};

describe('production bot worktrees with real Git owners', () => {
  test('publication binding is immutable, preserves the local owner and restores a missing item projection', async () => {
    const f = await setup();
    const checkout = await create(f);
    const h = publicationHarness(f);
    const lookup = await h.lookup();
    expect(await h.makeWorktrees().readPublication(lookup)).toBeNull();
    const before = JSON.parse(await fs.readFile(ownerFile(f), 'utf8'));
    expect(await h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/issue-42' })).toEqual({ publicationBranch: 'fix/issue-42' });
    expect(JSON.parse(await fs.readFile(ownerFile(f), 'utf8'))).toEqual({ ...before, publicationBranch: 'fix/issue-42' });
    expect(await h.makeWorktrees().readPublication(lookup)).toEqual({ publicationBranch: 'fix/issue-42', localBranch: 'bot/item-1',
      directory: checkout.directory, identityId: before.identityId, identityRevision: before.identityRevision });
    h.remotes.set('fix/issue-42', f.base);
    expect(await h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/issue-42' })).toEqual({ publicationBranch: 'fix/issue-42' });
    expect(h.reads).toEqual(['fix/issue-42']);
    await expect(h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/replacement' }))
      .rejects.toMatchObject({ code: 'BOT_PUBLICATION_IMMUTABLE' });
    f.item.publicationBranch = 'fix/issue-42';
    expect((await h.makeWorktrees().inspect(f.request)).remoteSha).toBe(f.base);
    expect(h.reads.at(-1)).toBe('fix/issue-42');
    expect((await botGit(checkout.directory, ['symbolic-ref', 'HEAD'])).trim()).toBe('refs/heads/bot/item-1');
    expect(await h.makeWorktrees().create(f.request)).toEqual(checkout);
    await expect(h.makeWorktrees().inspect({ ...f.request, item: { ...f.item, publicationBranch: 'fix/forged' } }))
      .rejects.toMatchObject({ code: 'BOT_WORKTREE_OWNERSHIP' });
  });

  test('two items and bots in one repository cannot race to reserve the same remote branch', async () => {
    const f = await setup();
    await create(f);
    const h = publicationHarness(f);
    const bot = { ...f.bot, id: 'bot-2' };
    const item = { ...f.item, id: 'item-2', botId: bot.id, worktree: undefined, branch: undefined };
    const request = { ...f.request, bot, item, key: 'item-2:worktree' };
    const second = h.makeWorktrees({ readItem: async () => item });
    const checkout = await second.create(request);
    Object.assign(item, { worktree: checkout.directory, branch: checkout.branch });
    const outcomes = await Promise.allSettled([
      h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/shared' }),
      second.bindPublication({ ...request, branch: 'fix/shared' }),
    ]);
    expect(outcomes.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value)).toEqual([{ publicationBranch: 'fix/shared' }]);
    expect(outcomes.filter((entry) => entry.status === 'rejected').map((entry) => entry.reason.code)).toEqual(['BOT_PUBLICATION_RESERVED']);
    const first = await h.makeWorktrees().readPublication(await h.lookup());
    const other = await second.readPublication({ ...await h.lookup(), botId: bot.id, itemId: item.id });
    expect([first, other].filter(Boolean)).toHaveLength(1);
    expect(h.reads).toEqual(['fix/shared']);
  });

  test('an existing reservation replays during later fixing rounds after publication effects', async () => {
    const f = await setup();
    await create(f);
    const h = publicationHarness(f);
    await h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/issue-42' });
    f.item.publicationBranch = 'fix/issue-42';
    f.item.effects = [{ kind: 'git.push', state: 'succeeded' }];

    expect(await h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/issue-42' }))
      .toEqual({ publicationBranch: 'fix/issue-42' });
  });

  test('new reservations refuse the base and preexisting remote branches even at the same SHA', async () => {
    const f = await setup();
    await create(f);
    const h = publicationHarness(f);
    await expect(h.makeWorktrees().bindPublication({ ...f.request, branch: 'main' }))
      .rejects.toMatchObject({ code: 'BOT_PUBLICATION_BASE' });
    h.remotes.set('fix/existing', f.base);
    await expect(h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/existing' }))
      .rejects.toMatchObject({ code: 'BOT_PUBLICATION_REMOTE_EXISTS' });
    expect(await h.makeWorktrees().readPublication(await h.lookup())).toBeNull();
    expect(await h.makeWorktrees().bindPublication({ ...f.request, branch: 'bot/item-1' })).toEqual({ publicationBranch: 'bot/item-1' });
  });

  test('registry commit survives a failed owner write and only the same owner and branch can replay it', async () => {
    const f = await setup();
    await create(f);
    const h = publicationHarness(f);
    const rename = fs.rename.bind(fs);
    const interrupted = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === ownerFile(f)) throw Object.assign(new Error('Interrupted owner commit'), { code: 'EIO' });
      return rename(from, to);
    });
    try {
      await expect(h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/recovery' })).rejects.toMatchObject({ code: 'EIO' });
    } finally { interrupted.mockRestore(); }
    expect(JSON.parse(await fs.readFile(ownerFile(f), 'utf8')).publicationBranch).toBeUndefined();
    const registry = await h.registryFile();
    const saved = await fs.readFile(registry, 'utf8');
    expect((await fs.stat(registry)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(registry))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await expect(h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/other' }))
      .rejects.toMatchObject({ code: 'BOT_PUBLICATION_IMMUTABLE' });
    h.remotes.set('fix/recovery', f.base);
    expect(await h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/recovery' })).toEqual({ publicationBranch: 'fix/recovery' });
    expect(await fs.readFile(registry, 'utf8')).toBe(saved);
    expect(h.reads).toEqual(['fix/recovery']);
    expect((await h.makeWorktrees().readPublication(await h.lookup())).publicationBranch).toBe('fix/recovery');
  });

  test('retained removing and removed owners keep their publication reservation and closure projection', async () => {
    const f = await setup();
    const checkout = await create(f);
    const h = publicationHarness(f);
    await h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/retained' });
    const lookup = await h.lookup();
    const publication = await h.makeWorktrees().readPublication(lookup);
    const registry = await h.registryFile();
    const saved = await fs.readFile(registry, 'utf8');
    const interrupted = h.makeWorktrees({ disposeInstance: async () => {
      await fs.writeFile(path.join(checkout.directory, 'keep'), 'arrived during disposal');
    } });
    await expect(interrupted.remove(f.request)).rejects.toMatchObject({ code: 'BOT_WORKTREE_DIRTY' });
    expect(JSON.parse(await fs.readFile(ownerFile(f), 'utf8')).state).toBe('removing');
    expect(await h.makeWorktrees().readPublication(lookup)).toEqual(publication);
    await fs.rm(path.join(checkout.directory, 'keep'));
    await h.makeWorktrees().remove(f.request);
    expect(JSON.parse(await fs.readFile(ownerFile(f), 'utf8')).state).toBe('removed');
    expect(await h.makeWorktrees().readPublication(lookup)).toEqual(publication);
    expect(await fs.readFile(registry, 'utf8')).toBe(saved);
    const item = { ...f.item, id: 'item-2', worktree: undefined, branch: undefined };
    const request = { ...f.request, item, key: 'item-2:worktree' };
    const next = h.makeWorktrees({ readItem: async () => item });
    await next.create(request);
    await expect(next.bindPublication({ ...request, branch: 'fix/retained' }))
      .rejects.toMatchObject({ code: 'BOT_PUBLICATION_RESERVED' });
  });

  test('publication reads refuse missing, malformed or mismatched private ownership and reservation metadata', async () => {
    const f = await setup();
    await create(f);
    const h = publicationHarness(f);
    await h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/verified' });
    const lookup = await h.lookup();
    const owner = ownerFile(f);
    const saved = await fs.readFile(owner, 'utf8');
    const record = JSON.parse(saved);
    for (const change of [{ repositoryId: 'repo_other' }, { botId: 'bot-other' }, { itemId: 'item-other' }, { branch: 'bot/other' },
      { identityId: 'other' }, { identityRevision: 2 }, { directory: f.directory }, { projectId: 'other' }, { key: 'other' },
      { gitIdentity: 'other' }, { publicationBranch: undefined }, { publicationBranch: 'fix/other' }, { state: 'preparing' }]) {
      await fs.writeFile(owner, JSON.stringify({ ...record, ...change }));
      await expect(h.makeWorktrees().readPublication(lookup)).rejects.toThrow();
    }
    await fs.writeFile(owner, '{');
    await expect(h.makeWorktrees().readPublication(lookup)).rejects.toThrow();
    await fs.rm(owner);
    await expect(h.makeWorktrees().readPublication(lookup)).rejects.toThrow();
    await fs.writeFile(owner, saved);
    const registry = await h.registryFile();
    const reservations = await fs.readFile(registry, 'utf8');
    await fs.writeFile(registry, '{');
    await expect(h.makeWorktrees().readPublication(lookup)).rejects.toThrow();
    await fs.rm(registry);
    await expect(h.makeWorktrees().readPublication(lookup)).rejects.toThrow();
    await fs.writeFile(registry, reservations);
    expect((await h.makeWorktrees().readPublication(lookup)).publicationBranch).toBe('fix/verified');
  });

  test('binding refuses changed identity, checkout ownership, caller projections and existing publication effects', async () => {
    const f = await setup();
    await create(f);
    const h = publicationHarness(f);
    for (const kind of ['git.push', 'pr.open', 'pr.auto-merge', 'pr.disable-auto-merge', 'pr.dequeue', 'pr.comment']) {
      f.item.effects = [{ kind, state: 'refused' }];
      await expect(h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/new' }))
        .rejects.toMatchObject({ code: 'BOT_PUBLICATION_ALREADY_STARTED' });
    }
    f.item.effects = [];
    f.item.pr = { number: 7 };
    await expect(h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/new' }))
      .rejects.toMatchObject({ code: 'BOT_PUBLICATION_ALREADY_STARTED' });
    delete f.item.pr;
    await expect(h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/new', item: { ...f.item, publicationBranch: 'fix/new' } }))
      .rejects.toMatchObject({ code: 'BOT_WORKTREE_OWNERSHIP' });
    await expect(h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/new', item: { ...f.item, worktree: f.directory } }))
      .rejects.toMatchObject({ code: 'BOT_WORKTREE_OWNERSHIP' });
    await f.selectApp();
    await expect(h.makeWorktrees().bindPublication({ ...f.request, branch: 'fix/new' }))
      .rejects.toMatchObject({ code: 'BOT_IDENTITY_CHANGED' });
    expect(await h.makeWorktrees().readPublication(await h.lookup())).toBeNull();
  });

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
