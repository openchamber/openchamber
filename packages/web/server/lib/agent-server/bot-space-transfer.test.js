import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTransfers, ID, transferFixture } from './space-transfer-fixture.js';
import { readBoundedBody } from './agent-upstream.js';
import { createCodeIn } from '../spaces/code-in.js';
import { createCodeOut } from '../spaces/code-out.js';
import { advanceBotCheckout } from '../bots/production-git.js';
import { readTrustedBotMigrationPaths } from '../bots/production-worktrees.js';
import { createBotExecutionServices } from '../bots/agent-execution.js';
import { botDefinitionSchema } from '../bots/config.js';
import { trustMigratedBotCheckout } from './git-trust.js';

afterEach(cleanupTransfers);
const answer = async (response) => ({ status: response.statusCode, body: JSON.parse(await readBoundedBody(response, 65536)) });
const mutantWorktrees = async (f, name, before, after) => {
  const ownerModule = new URL('../bots/production-worktrees.js', import.meta.url);
  const original = fs.readFileSync(ownerModule, 'utf8');
  expect(original.includes(before)).toBe(true);
  const directory = fs.mkdtempSync(path.join(f.host.root, `mutation-${name}-`));
  const source = original.replace(before, after).replace(/from (['"])([^'"]+)\1/g, (_match, _quote, specifier) =>
    `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, ownerModule).href : import.meta.resolve(specifier))}`);
  const file = path.join(directory, 'owner.mjs');
  fs.writeFileSync(file, source);
  const { createProductionBotWorktrees } = await import(/* @vite-ignore */ pathToFileURL(file).href);
  return createProductionBotWorktrees({ dataDir: f.dataDir, context: f.production.context, readItem: async () => f.production.item });
};

describe('captured bot checkout transfer', () => {
  it('reconciles a migrated removed checkout and reads its publication through typed execution without trusting missing paths', async () => {
    const f = await transferFixture({ botCheckout: true, migrated: true });
    const { trustedMigrationPath } = f;
    const request = { ...f.production.request, trustedMigrationPath };
    await f.production.makeWorktrees().bindPublication({ ...request, branch: 'fix/retained' });
    await f.production.makeWorktrees().remove(request); // Its response is deliberately not given to an owner.
    const record = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'bot-worktrees', `${path.basename(f.repo)}.json`)));
    const project = f.production.project;
    const bot = botDefinitionSchema.parse({ name: 'Migrated', mission: 'Retain original execution', ...f.production.bot });
    const scope = { project, bot, item: f.production.item, checkoutKey: request.key, trustedMigrationPath };
    const gitCalls = [];
    const execution = createBotExecutionServices({ agentServer: true, dataDir: f.dataDir,
      readSettings: async () => ({ projects: [project] }), listProjects: async () => [project],
      worktrees: f.production.makeWorktrees(), services: {}, stages: {}, activity: {}, proof: {}, blame: async () => [],
      gateway: { stop() {} }, context: { ...f.production.context, repository: async () => ({ target: { repositoryId: record.repositoryId } }) },
      trustMigrationPath: (mapping, options) => trustMigratedBotCheckout({ mapping, ...options,
        runGit: async (args) => { gitCalls.push(args); return { code: 1, stdout: '' }; } }),
    });
    try {
      expect(await execution.execute('worktree-reconcile', { scope, key: request.key, operation: 'remove' }))
        .toEqual({ state: 'succeeded', result: { id: scope.item.id } });
      expect(await execution.execute('worktree-remove', { scope, key: request.key })).toEqual({ id: scope.item.id });
      expect(await execution.execute('worktree-read-publication', { scope, repositoryId: record.repositoryId }))
        .toMatchObject({ directory: f.repo, publicationBranch: 'fix/retained' });
      await expect(execution.execute('worktree-inspect', { scope })).rejects.toMatchObject({ code: 'ENOENT' });
      expect(gitCalls).toEqual([]);
    } finally { await execution.stop(); }
  });

  it('requires owner-local migration authority for retained paths and preserves original directories and descriptors', async () => {
    const f = await transferFixture({ botCheckout: true, migrated: true });
    const file = path.join(f.dependencies.dataDir, 'bots/migration-paths.json');
    const body = fs.readFileSync(file, 'utf8');
    const originalDescriptor = fs.readFileSync(`${f.repo}.json`, 'utf8');
    fs.rmSync(file);
    // The agent mirror exists and is deliberately insufficient to grant owner authority.
    expect(fs.existsSync(path.join(f.dataDir, 'bot-worktrees/migration-paths.json'))).toBe(true);
    await expect(f.codeIn.bringCodeIn(f.input)).rejects.toMatchObject({ code: 'BOT_MIGRATION_PATH_AUTHORITY_REQUIRED' });
    const unprotected = await mutantWorktrees(f, 'migration',
      "if (record.directory !== location({ project: { id: record.projectId }, item: { id: record.itemId } }).directory\n      && request.trustedMigrationPath === undefined) fail('BOT_MIGRATION_PATH_AUTHORITY_REQUIRED');", '');
    await expect(assert.rejects(() => unprotected.resolveTransferSource(f.source), { code: 'BOT_MIGRATION_PATH_AUTHORITY_REQUIRED' }))
      .rejects.toMatchObject({ code: 'ERR_ASSERTION', message: expect.stringContaining('Missing expected rejection') });
    await expect(f.production.makeWorktrees().resolveTransferSource(f.source)).rejects.toMatchObject({ code: 'BOT_MIGRATION_PATH_AUTHORITY_REQUIRED' });
    fs.writeFileSync(file, body);
    const captured = await readTrustedBotMigrationPaths({ dataDir: f.dependencies.dataDir });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured[0])).toBe(true);
    const trustedMigrationPath = captured[0];
    const descriptor = path.join(f.dataDir, 'bot-worktrees', `${path.basename(f.repo)}.json`);
    fs.renameSync(descriptor, `${descriptor}.retained`);
    await expect(f.production.makeWorktrees().create({ ...f.production.request, trustedMigrationPath }))
      .rejects.toMatchObject({ code: 'BOT_MIGRATION_PATH_AUTHORITY_MISMATCH' });
    fs.renameSync(`${descriptor}.retained`, descriptor);
    const wrong = { ...trustedMigrationPath, gitIdentity: '0:0' };
    await expect(f.production.makeWorktrees().resolveTransferSource(f.source, { trustedMigrationPath: wrong }))
      .rejects.toMatchObject({ code: 'BOT_MIGRATION_PATH_AUTHORITY_MISMATCH' });
    expect(await f.production.makeWorktrees().resolveTransferSource(f.source, { trustedMigrationPath })).toBe(f.repo);
    const codeIn = createCodeIn(f.dependencies);
    const arrived = await codeIn.bringCodeIn(f.input);
    expect(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'space-transfer', `${ID}.json`))).trustedMigrationPath).toEqual(trustedMigrationPath);
    expect(await codeIn.sendHistory({ ...f.input, spacePath: arrived.spacePath, base: arrived.base })).toEqual({ status: 'sent' });
    fs.writeFileSync(path.join(f.local.local(arrived.spacePath), 'retained-result'), 'retained checkout\n');
    const result = await f.codeOut.bringCodeOut({ ...f.input, spacePath: arrived.spacePath });
    const request = { ...f.production.request, trustedMigrationPath };
    await expect(f.production.makeWorktrees().adoptIsolated({ ...request, trustedMigrationPath: undefined, resultSha: result.result, spaceId: ID }))
      .rejects.toMatchObject({ code: 'BOT_MIGRATION_PATH_AUTHORITY_REQUIRED' });
    expect(await f.production.makeWorktrees().adoptIsolated({ ...request, resultSha: result.result, spaceId: ID })).toEqual({ headSha: result.result });
    expect((await f.production.makeWorktrees().create(request)).directory).toBe(f.repo);
    expect(await f.production.makeWorktrees().bindPublication({ ...request, branch: 'fix/retained' })).toEqual({ publicationBranch: 'fix/retained' });
    const lookup = { repositoryId: JSON.parse(originalDescriptor).repositoryId, botId: f.production.bot.id, itemId: f.production.item.id, trustedMigrationPath };
    expect(await f.production.makeWorktrees().readPublication(lookup)).toMatchObject({ directory: f.repo, publicationBranch: 'fix/retained' });
    const stat = fs.statSync(f.repo, { bigint: true });
    expect(`${stat.dev}:${stat.ino}`).toBe(trustedMigrationPath.directoryIdentity);
    expect(fs.readFileSync(`${f.repo}.json`, 'utf8')).toBe(originalDescriptor);
    await codeIn.removeSpaceRefs(f.input);
    expect(await f.production.makeWorktrees().remove(request)).toEqual({ id: f.production.item.id });
    expect(await f.production.makeWorktrees().readPublication(lookup)).toMatchObject({ directory: f.repo, publicationBranch: 'fix/retained' });
    process.stdout.write('Mutation control: retained-path refusal RED without owner migration authority; original owner GREEN.\n');
  });

  it('copies an owned checkout, resumes history and promotes only its bound result for adoption', async () => {
    const f = await transferFixture({ botCheckout: true });
    expect(await f.production.makeWorktrees().resolveTransferSource(f.source)).toBe(f.repo);
    const arrived = await f.codeIn.bringCodeIn(f.input);
    const metadata = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'space-transfer', `${ID}.json`)));
    expect(metadata.source).toEqual(f.source);
    const dependencies = { ...f.dependencies, dataDir: path.join(f.host.root, 'restart') };
    const restartedIn = createCodeIn(dependencies);
    expect(await restartedIn.sendHistory({ ...f.input, base: arrived.base, spacePath: arrived.spacePath })).toEqual({ status: 'sent' });
    fs.writeFileSync(path.join(f.local.local(arrived.spacePath), 'isolated.txt'), 'checked result\n');
    const result = await createCodeOut(dependencies).bringCodeOut({ ...f.input, spacePath: arrived.spacePath });
    expect(result.association).toEqual({ spaceId: ID, source: f.source });
    const association = { spaceId: ID, source: f.source };
    const request = { ...f.production.request, resultSha: result.result, association };
    await expect(f.production.makeWorktrees().adoptIsolated({ ...request, association: { ...association, spaceId: 'f'.repeat(12) } })).rejects.toMatchObject({ code: 'BOT_ISOLATED_RESULT_NOT_PROMOTED' });
    await expect(f.production.makeWorktrees().adoptIsolated({ ...request, association: { ...association, source: { ...f.source, checkoutKey: 'wrong' } } })).rejects.toMatchObject({ code: 'BOT_ISOLATED_SOURCE_MISMATCH' });
    await expect(f.production.makeWorktrees().adoptIsolated({ ...request, resultSha: arrived.base })).rejects.toMatchObject({ code: 'BOT_ISOLATED_RESULT_NOT_PROMOTED' });
    await expect(f.production.makeWorktrees().adoptIsolated({ ...f.production.request, resultSha: result.result, spaceId: 'f'.repeat(12) })).rejects.toMatchObject({ code: 'BOT_ISOLATED_RESULT_NOT_PROMOTED' });
    expect(await f.production.makeWorktrees().adoptIsolated({ ...f.production.request, resultSha: result.result, spaceId: ID })).toEqual({ headSha: result.result });
    expect(fs.readFileSync(path.join(f.repo, 'isolated.txt'), 'utf8')).toBe('checked result\n');
    expect(f.g(['for-each-ref', '--format=%(objectname)', `refs/openchamber/spaces/${ID}/result`]).trim()).toBe(result.result);
    await restartedIn.removeSpaceRefs(f.input);
    expect(await restartedIn.removeSpaceRefs(f.input)).toEqual([]);
    expect(f.g(['for-each-ref', '--format=%(refname)', `refs/openchamber/spaces/${ID}/`])).toBe('');
    expect(fs.existsSync(path.join(f.dataDir, 'space-transfer', `${ID}.json`))).toBe(false);
    expect(f.executed.length).toBeGreaterThan(0);
  });

  it('refuses wrong owner, key and registered-parent identity before snapshotting', async () => {
    const f = await transferFixture({ botCheckout: true });
    for (const [patch, code] of [[{ itemId: 'wrong' }, 'BOT_WORKTREE_OWNERSHIP'], [{ botId: 'wrong' }, 'BOT_WORKTREE_OWNERSHIP'],
      [{ checkoutKey: ID }, 'BOT_WORKTREE_OWNERSHIP'], [{ projectId: 'wrong' }, 'agent_project_mismatch']]) {
      const response = await answer(await f.upstream.request({ path: f.route('snapshot', { source: JSON.stringify({ ...f.source, ...patch }) }),
        method: 'POST', body: '{"mode":"clean"}' }));
      expect(response).toMatchObject({ status: 400, body: { code } });
    }
    expect(f.g(['for-each-ref', '--format=%(refname)', 'refs/openchamber/spaces/'])).toBe('');
    const ordinary = await answer(await f.upstream.request({ path: f.route('snapshot', { directory: f.repo, source: JSON.stringify({ kind: 'project', directory: f.repo }) }), method: 'POST', body: '{"mode":"clean"}' }));
    expect(ordinary).toMatchObject({ status: 403, body: { code: 'agent_project_unregistered' } });
  });

  it('refuses a replaced checkout filesystem identity with the original live owner as control', async () => {
    const f = await transferFixture({ botCheckout: true });
    expect(await f.production.makeWorktrees().resolveTransferSource(f.source)).toBe(f.repo);
    fs.renameSync(f.repo, `${f.repo}.retained`);
    fs.cpSync(`${f.repo}.retained`, f.repo, { recursive: true });
    await expect(f.production.makeWorktrees().resolveTransferSource(f.source)).rejects.toMatchObject({ code: 'BOT_WORKTREE_OWNERSHIP' });
  });

  it('binds all later operations to the original source even for another valid checkout in the same repository', async () => {
    const f = await transferFixture({ botCheckout: true });
    const arrived = await f.codeIn.bringCodeIn(f.input);
    const other = { ...f.production.item, id: 'item-2', worktree: undefined, branch: undefined };
    const request = { ...f.production.request, item: other, key: 'item-2:worktree' };
    const checkout = await f.production.makeWorktrees().create(request);
    Object.assign(other, { worktree: checkout.directory, branch: checkout.branch });
    // The authoritative reader now returns this other live item; both owners remain genuine.
    Object.assign(f.production.item, other);
    const source = { ...f.source, itemId: other.id, checkoutKey: request.key };
    for (const [method, operation] of [['GET', 'snapshot'], ['GET', 'bundle'], ['GET', 'apply-state'],
      ['POST', 'apply-branch'], ['POST', 'apply-changes'], ['POST', 'result'], ['DELETE', 'refs']]) {
      const query = { source: JSON.stringify(source) };
      if (operation === 'result') Object.assign(query, { start: arrived.start, result: arrived.start });
      const request = { method, path: f.route(operation, query) };
      if (method === 'POST') request.body = operation === 'apply-branch' ? '{"branch":"checked-result"}' : operation === 'result' ? '' : '{}';
      const response = await answer(await f.upstream.request(request));
      expect(response).toMatchObject({ status: 400, body: { code: 'agent_project_mismatch' } });
    }
    expect(fs.existsSync(path.join(f.dataDir, 'space-transfer', `${ID}.json`))).toBe(true);
    expect(f.g(['rev-parse', '--verify', `refs/openchamber/spaces/${ID}/start`]).trim()).toMatch(/^[a-f0-9]{40}$/);
  });

  it('does not reconstruct a bot binding from legacy refs or silently replace malformed source metadata', async () => {
    const f = await transferFixture({ botCheckout: true });
    const arrived = await f.codeIn.bringCodeIn(f.input);
    const file = path.join(f.dataDir, 'space-transfer', `${ID}.json`);
    const metadata = fs.readFileSync(file, 'utf8');
    fs.rmSync(file);
    const missing = await answer(await f.upstream.request({ path: f.route('snapshot', { base: arrived.base }) }));
    expect(missing.body.code).toBe('agent_snapshot_missing');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(metadata), source: { ...f.source, directory: f.repo } }));
    const invalid = await answer(await f.upstream.request({ path: f.route('snapshot') }));
    expect(invalid.body.code).toBe('agent_metadata_invalid');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(metadata), source: { ...f.source, checkoutKey: 'different:worktree' } }));
    const changed = await answer(await f.upstream.request({ path: f.route('snapshot') }));
    expect(changed.body.code).toBe('agent_source_mismatch');
    fs.writeFileSync(file, metadata);
    await f.codeIn.removeSpaceRefs(f.input);
  });

  it('retains the exact source association across interrupted adoption and refuses an omitted restart binding', async () => {
    const f = await transferFixture({ botCheckout: true });
    const arrived = await f.codeIn.bringCodeIn(f.input);
    fs.writeFileSync(path.join(f.local.local(arrived.spacePath), 'restart-result'), 'result\n');
    const result = await f.codeOut.bringCodeOut({ ...f.input, spacePath: arrived.spacePath });
    const request = { ...f.production.request, resultSha: result.result, spaceId: ID };
    const interrupted = f.production.makeWorktrees({ advanceCheckout: async (input) => {
      await advanceBotCheckout(input);
      throw new Error('Interrupted after guarded materialization');
    } });
    await expect(interrupted.adoptIsolated(request)).rejects.toThrow('Interrupted after guarded materialization');
    const record = JSON.parse(fs.readFileSync(`${f.repo}.json`, 'utf8'));
    expect(record.adoption.association).toEqual({ spaceId: ID, source: f.source });
    await expect(f.production.makeWorktrees().adoptIsolated({ ...request, spaceId: undefined }))
      .rejects.toMatchObject({ code: 'BOT_ISOLATED_SOURCE_MISMATCH' });
    expect(await f.production.makeWorktrees().adoptIsolated(request)).toEqual({ headSha: result.result });
    await f.codeIn.removeSpaceRefs(f.input);
  });

  it('turns ownership and exact-space adoption assertions red in disposable module copies, then restores green', async () => {
    const f = await transferFixture({ botCheckout: true });
    const unprotectedOwner = await mutantWorktrees(f, 'ownership', 'const record = await read(request);\n        await verifyCheckout(request, record);\n        if (record.state !== \'ready\')',
      'const record = await read(request);\n        await validateRecord(request, record);\n        if (record.state !== \'ready\')');
    expect(await f.production.makeWorktrees().resolveTransferSource(f.source)).toBe(f.repo);
    fs.renameSync(f.repo, `${f.repo}.original`);
    fs.cpSync(`${f.repo}.original`, f.repo, { recursive: true });
    await expect(f.production.makeWorktrees().resolveTransferSource(f.source)).rejects.toMatchObject({ code: 'BOT_WORKTREE_OWNERSHIP' });
    await expect(assert.rejects(() => unprotectedOwner.resolveTransferSource(f.source), { code: 'BOT_WORKTREE_OWNERSHIP' }))
      .rejects.toMatchObject({ code: 'ERR_ASSERTION', message: expect.stringContaining('Missing expected rejection') });
    fs.rmSync(f.repo, { recursive: true });
    fs.renameSync(`${f.repo}.original`, f.repo);
    expect(await f.production.makeWorktrees().resolveTransferSource(f.source)).toBe(f.repo);

    const arrived = await f.codeIn.bringCodeIn(f.input);
    fs.writeFileSync(path.join(f.local.local(arrived.spacePath), 'mutation-result'), 'result\n');
    const result = await f.codeOut.bringCodeOut({ ...f.input, spacePath: arrived.spacePath });
    const wrongSpace = { ...f.production.request, resultSha: result.result, spaceId: 'f'.repeat(12) };
    await expect(f.production.makeWorktrees().adoptIsolated(wrongSpace)).rejects.toBeDefined();
    const unprotectedAdoption = await mutantWorktrees(f, 'association', 'const associatedRef = association && await verifyAssociation(record, association, resultSha, request.trustedMigrationPath);', 'const associatedRef = undefined;');
    await expect(assert.rejects(() => unprotectedAdoption.adoptIsolated(wrongSpace)))
      .rejects.toMatchObject({ code: 'ERR_ASSERTION', message: expect.stringContaining('Missing expected rejection') });
    await expect(f.production.makeWorktrees().adoptIsolated(wrongSpace)).rejects.toBeDefined();
    expect(await f.production.makeWorktrees().adoptIsolated({ ...wrongSpace, spaceId: ID })).toEqual({ headSha: result.result });
    process.stdout.write('Mutation controls: replaced-inode refusal RED without checkout verification; wrong-space adoption refusal RED without transfer association; original owner GREEN.\n');
  });
});
