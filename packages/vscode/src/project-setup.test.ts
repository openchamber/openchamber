import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ProjectSetupValidationError,
  mergeProjectSetup,
  normalizePlansDir,
  parseSharedProjectConfig,
  personalProjectSetupOf,
  projectSetupPatchToStored,
  sanitizeDraftStarters,
  sanitizeProjectActions,
  sanitizeSetupCommands,
  sharedTrustHashOf,
  type PersonalProjectSetup,
} from './project-setup';
import { createProjectSetupStore, handleProjectSetupBridgeMessage, projectPathFromId } from './bridge-project-setup-runtime';

const emptyPersonal: PersonalProjectSetup = {
  setupWorktree: [],
  setupWorktreeWait: null,
  setupWorktreeMode: 'append',
  projectActions: [],
  projectActionsPrimaryId: null,
  draftStarters: [],
  hiddenSharedActionIds: [],
  sharedTrust: null,
};

const projectIdFor = (projectPath: string): string => `path_${Buffer.from(projectPath, 'utf8').toString('base64url')}`;

describe('project setup sanitizers', () => {
  test('keeps only non-empty trimmed setup commands', () => {
    assert.deepEqual(sanitizeSetupCommands([' bun install ', '', 42, '\n']), ['bun install']);
    assert.deepEqual(sanitizeSetupCommands('bun install'), []);
  });

  test('drops incomplete actions and duplicate ids, keeps only set optional fields', () => {
    assert.deepEqual(sanitizeProjectActions([
      { id: 'a', name: 'Dev', command: 'bun run dev', runIn: 'parent', platforms: ['macos', 'plan9'], icon: '' },
      { id: 'a', name: 'Again', command: 'x' },
      { id: '', name: 'No id', command: 'x' },
      { id: 'b', name: 'B', command: 'x', runIn: 'worktree' },
    ]), [
      { id: 'a', name: 'Dev', command: 'bun run dev', icon: null, platforms: ['macos'], runIn: 'parent' },
      { id: 'b', name: 'B', command: 'x', icon: null },
    ]);
  });

  test('dedupes draft starters by type and name', () => {
    assert.deepEqual(sanitizeDraftStarters([
      { type: 'skill', name: 'triage-prs' },
      { type: 'skill', name: 'triage-prs' },
      { type: 'agent', name: 'nope' },
    ]), [{ type: 'skill', name: 'triage-prs' }]);
  });

  test('builds the personal view from on-disk keys and nulls a dangling primary action', () => {
    assert.deepEqual(personalProjectSetupOf({
      'setup-worktree': ['bun install'],
      'setup-worktree-wait': true,
      setupWorktreeMode: 'replace',
      projectActions: [{ id: 'a', name: 'A', command: 'x' }],
      projectActionsPrimaryId: 'missing',
      hiddenSharedActionIds: ['dev', 'dev', 3],
    }), {
      setupWorktree: ['bun install'],
      setupWorktreeWait: true,
      setupWorktreeMode: 'replace',
      projectActions: [{ id: 'a', name: 'A', command: 'x', icon: null }],
      projectActionsPrimaryId: null,
      draftStarters: [],
      hiddenSharedActionIds: ['dev'],
      sharedTrust: null,
    });
    assert.deepEqual(personalProjectSetupOf(null), emptyPersonal);
  });

  test('parses a shared file and refuses a broken one', () => {
    const ok = parseSharedProjectConfig(JSON.stringify({ version: 1, setupWorktree: ['bun install'], plansDir: 'docs/plans' }));
    assert.equal(ok.status, 'ok');
    if (ok.status === 'ok') {
      assert.deepEqual(ok.config, { setupWorktree: ['bun install'], setupWorktreeWait: null, projectActions: [], draftStarters: [], plansDir: 'docs/plans' });
    }
    assert.equal(parseSharedProjectConfig('{ nope').status, 'invalid');
    assert.equal(parseSharedProjectConfig('{"version":2}').status, 'invalid');
    assert.equal(parseSharedProjectConfig('{"version":1,"plansDir":"../x"}').status, 'invalid');
    assert.equal(normalizePlansDir('./docs/plans/'), 'docs/plans');
    assert.equal(normalizePlansDir('/abs'), null);
  });

  test('merges shared and personal by the agreed rules', () => {
    const merged = mergeProjectSetup({
      ...emptyPersonal,
      setupWorktree: ['mine'],
      projectActions: [{ id: 'test', name: 'My test', command: 'x', icon: null }],
      hiddenSharedActionIds: ['lint'],
      draftStarters: [{ type: 'command', name: 'both' }, { type: 'command', name: 'mine' }],
    }, {
      status: 'ok',
      config: {
        setupWorktree: ['bun install'],
        setupWorktreeWait: true,
        projectActions: [
          { id: 'dev', name: 'Dev', command: 'd', icon: null },
          { id: 'test', name: 'Test', command: 't', icon: null },
          { id: 'lint', name: 'Lint', command: 'l', icon: null },
        ],
        draftStarters: [{ type: 'command', name: 'both' }],
        plansDir: null,
      },
    });
    assert.deepEqual(merged.setupWorktree, ['bun install', 'mine']);
    assert.equal(merged.setupWorktreeWait, true);
    assert.deepEqual(merged.projectActions.map((action) => `${action.id}:${action.source}`), ['dev:shared', 'test:personal']);
    assert.deepEqual(merged.draftStarters.map((starter) => `${starter.name}:${starter.source}`), ['both:shared', 'mine:personal']);
    assert.equal(merged.trust.trusted, false);
    assert.match(merged.trust.hash ?? '', /^sha256:/);
  });

  test('trusts only the recorded hash and nothing when nothing executes', () => {
    const shared = { setupWorktree: ['bun install'], setupWorktreeWait: null, projectActions: [], draftStarters: [], plansDir: null };
    const hash = sharedTrustHashOf(shared);
    assert.equal(mergeProjectSetup({ ...emptyPersonal, sharedTrust: { hash: hash ?? '', trustedAt: 1 } }, { status: 'ok', config: shared }).trust.trusted, true);
    assert.equal(mergeProjectSetup({ ...emptyPersonal, sharedTrust: { hash: 'sha256:old', trustedAt: 1 } }, { status: 'ok', config: shared }).trust.trusted, false);
    assert.deepEqual(mergeProjectSetup(emptyPersonal, { status: 'missing' }).trust, { hash: null, trusted: true });
    assert.equal(sharedTrustHashOf({ ...shared, setupWorktree: [] }), null);
    assert.deepEqual(projectSetupPatchToStored({ sharedTrustHash: null }), { sharedTrust: undefined });
    assert.throws(() => projectSetupPatchToStored({ sharedTrustHash: '' }), ProjectSetupValidationError);
  });

  test('rejects wrongly shaped patch keys', () => {
    assert.throws(() => projectSetupPatchToStored({ setupWorktree: 'x' }), ProjectSetupValidationError);
    assert.throws(() => projectSetupPatchToStored(null), ProjectSetupValidationError);
    assert.deepEqual(projectSetupPatchToStored({ projectActionsPrimaryId: null }), { projectActionsPrimaryId: undefined });
  });
});

describe('project setup bridge', () => {
  const withStore = async (run: (store: ReturnType<typeof createProjectSetupStore>, dir: string) => Promise<void>) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-project-setup-'));
    try {
      await run(createProjectSetupStore(dir), dir);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  };

  test('round-trips a patch through the bridge and preserves foreign keys', async () => {
    await withStore(async (store, dir) => {
      await fs.promises.writeFile(path.join(dir, 'project-a.json'), JSON.stringify({
        version: 1,
        scheduledTasks: [{ id: 'keep' }],
        'setup-worktree': ['old'],
      }));

      const updated = await handleProjectSetupBridgeMessage(
        { id: '1', type: 'api:project-setup:update', payload: { projectId: 'project-a', patch: { setupWorktree: ['bun install'], projectPath: '/repo' } } },
        store,
      );
      assert.equal(updated?.success, true);
      const view = updated?.data as { setupWorktree: string[]; setupWorktreeWait: boolean; shared: { status: string } };
      assert.deepEqual(view.setupWorktree, ['bun install']);
      assert.equal(view.setupWorktreeWait, false);
      assert.equal(view.shared.status, 'missing');

      const raw = JSON.parse(await fs.promises.readFile(path.join(dir, 'project-a.json'), 'utf8'));
      assert.deepEqual(raw.scheduledTasks, [{ id: 'keep' }]);
      assert.equal(raw.projectPath, '/repo');

      const read = await handleProjectSetupBridgeMessage({ id: '2', type: 'api:project-setup:get', payload: { projectId: 'project-a' } }, store);
      assert.deepEqual(read?.data, updated?.data);
    });
  });

  test('answers a bad patch or project id with a failure, and ignores other messages', async () => {
    await withStore(async (store) => {
      const bad = await handleProjectSetupBridgeMessage(
        { id: '1', type: 'api:project-setup:update', payload: { projectId: 'project-a', patch: { setupWorktree: 'x' } } },
        store,
      );
      assert.equal(bad?.success, false);
      assert.match(bad?.error ?? '', /setupWorktree must be/);

      const badId = await handleProjectSetupBridgeMessage({ id: '2', type: 'api:project-setup:get', payload: { projectId: '../etc' } }, store);
      assert.equal(badId?.success, false);

      assert.equal(await handleProjectSetupBridgeMessage({ id: '3', type: 'api:fs:read', payload: {} }, store), null);
    });
  });

  test('reads the shared file from the checkout the id names', async () => {
    await withStore(async (store, dir) => {
      const repo = path.join(dir, 'repo');
      await fs.promises.mkdir(path.join(repo, '.openchamber'), { recursive: true });
      await fs.promises.writeFile(path.join(repo, '.openchamber', 'project.json'), JSON.stringify({
        version: 1,
        setupWorktree: ['bun install'],
        projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }],
      }));
      const projectId = projectIdFor(repo);
      assert.equal(projectPathFromId(projectId), repo);
      const view = await store.update(projectId, { setupWorktree: ['mine'], hiddenSharedActionIds: ['dev'] });
      assert.equal(view.shared.status, 'ok');
      assert.deepEqual(view.setupWorktree, ['bun install', 'mine']);
      assert.deepEqual(view.projectActions, []);
      await fs.promises.writeFile(path.join(repo, '.openchamber', 'project.json'), '{ broken');
      const broken = await store.read(projectId);
      assert.equal(broken.shared.status, 'invalid');
      assert.deepEqual(broken.setupWorktree, ['mine']);
    });
  });

  test('writes and removes the shared file through the bridge, trusting the writer', async () => {
    await withStore(async (store, dir) => {
      const repo = path.join(dir, 'repo');
      await fs.promises.mkdir(repo, { recursive: true });
      const projectId = projectIdFor(repo);
      const shared = await handleProjectSetupBridgeMessage(
        { id: '1', type: 'api:project-setup:update-shared', payload: { projectId, patch: { setupWorktree: ['bun install'], plansDir: 'docs/plans' } } },
        store,
      );
      assert.equal(shared?.success, true);
      const view = shared?.data as { trust: { trusted: boolean }; shared: { status: string; plansDir: string | null } };
      assert.equal(view.shared.status, 'ok');
      assert.equal(view.shared.plansDir, 'docs/plans');
      assert.equal(view.trust.trusted, true);
      const raw = JSON.parse(await fs.promises.readFile(path.join(repo, '.openchamber', 'project.json'), 'utf8'));
      assert.deepEqual(raw, { version: 1, setupWorktree: ['bun install'], plansDir: 'docs/plans' });

      const emptied = await store.updateShared(projectId, { setupWorktree: [], plansDir: null });
      assert.equal(emptied.shared.status, 'missing');
      assert.equal(fs.existsSync(path.join(repo, '.openchamber')), false);

      const missing = await handleProjectSetupBridgeMessage(
        { id: '2', type: 'api:project-setup:update-shared', payload: { projectId: projectIdFor(path.join(dir, 'nope')), patch: {} } },
        store,
      );
      assert.equal(missing?.success, false);
      assert.match(missing?.error ?? '', /checkout not found/);
    });
  });

  test('serializes two quick updates to one file', async () => {
    await withStore(async (store, dir) => {
      await Promise.all([
        store.update('project-a', { setupWorktree: ['a'] }),
        store.update('project-a', { draftStarters: [{ type: 'skill', name: 's' }] }),
      ]);
      const raw = JSON.parse(await fs.promises.readFile(path.join(dir, 'project-a.json'), 'utf8'));
      assert.deepEqual(raw['setup-worktree'], ['a']);
      assert.deepEqual(raw.draftStarters, [{ type: 'skill', name: 's' }]);
    });
  });
});
