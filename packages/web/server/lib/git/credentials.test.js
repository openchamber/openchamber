import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createManagedSshInventory } from './credentials.js';
import { createManagedSshCredentialStore } from './ssh-credential-storage.js';
import { createGitCredentialResolver, createSshCredentialReference, inspectManagedSshCredential } from './credential-resolver.js';
import { registerGitRoutes } from './routes.js';
import { createBindingService } from '../source-control/binding-service.js';
import { createBindingStore } from '../source-control/binding-storage.js';
import { fingerprintRemoteUrl } from '../source-control/url-redaction.js';
import { createSshPassphraseStore } from './ssh-passphrases.js';

const execFileAsync = promisify(execFile);
const run = (file, args, options = {}) => execFileAsync(file, args, { windowsHide: true, ...options });
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const fixture = async (inventoryOptions = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-ssh-inventory-'));
  roots.push(root);
  const discoveryRoot = path.join(root, '.ssh');
  await fs.mkdir(discoveryRoot, { mode: 0o700 });
  const privateKeyPath = path.join(discoveryRoot, 'id_ed25519');
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'private-comment-canary', '-f', privateKeyPath]);
  const fingerprint = (await run('ssh-keygen', ['-lf', `${privateKeyPath}.pub`, '-E', 'sha256'])).stdout.split(' ')[1];
  const record = { id: 'key_one', privateKeyPath, fingerprint };
  const filePath = path.join(root, 'git-ssh-credentials.json');
  const snapshotRoot = path.join(root, 'snapshots');
  const managedKeyRoot = path.join(root, 'managed-keys');
  const store = createManagedSshCredentialStore({ filePath });
  const inventory = createManagedSshInventory({ store, snapshotRoot, discoveryRoot, managedKeyRoot, ...inventoryOptions });
  const app = express();
  app.use(express.json());
  registerGitRoutes(app, { managedSshInventory: inventory });
  return { root, record, filePath, snapshotRoot, discoveryRoot, managedKeyRoot, store, inventory, app };
};

describe('connected-server managed SSH inventory', () => {
  it('imports encrypted bytes, stores only a credential reference, and unlocks operation snapshots', async () => {
    const entries = [];
    const passphrases = createSshPassphraseStore({
      create: async (entry) => { entries.push(entry); }, list: async () => entries,
      remove: async (id) => { entries.splice(entries.findIndex((entry) => entry.id === id), 1); },
    });
    const passphrase = 'fixture secret $"\\ with spaces';
    const { inventory, app, record, store, filePath, snapshotRoot } = await fixture({ passphrases });
    await run('ssh-keygen', ['-p', '-P', '', '-N', passphrase, '-f', record.privateKeyPath]);
    for (const supplied of ['', 'incorrect']) {
      const result = await inventory.discover({ passphrase: supplied });
      expect(result.candidates[0].capability.status).toBe('unavailable');
      expect(await fs.readdir(snapshotRoot)).toEqual([]);
      const candidate = (await inventory.discover({ passphrase })).candidates[0];
      expect(await inventory.import({ candidateId: candidate.candidateId, expectedFingerprint: candidate.fingerprint,
        confirmed: true, passphrase: supplied })).toEqual({ status: 'rejected', reason: 'candidate-unavailable' });
      expect((await store.read()).keys).toEqual([]);
      expect(entries).toEqual([]);
      expect(await fs.readdir(snapshotRoot)).toEqual([]);
    }
    const discovery = await request(app).post('/api/git/managed-ssh-credentials')
      .send({ operation: 'discover', passphrase }).expect(200);
    const candidate = discovery.body.candidates[0];
    expect(candidate.fingerprint).toBe(record.fingerprint);
    expect(entries).toEqual([]);
    const imported = await request(app).post('/api/git/managed-ssh-credentials').send({ operation: 'import',
      candidateId: candidate.candidateId, expectedFingerprint: candidate.fingerprint, confirmed: true, passphrase }).expect(200);
    expect(imported.body.selectedCredential.capability.status).toBe('ready');
    expect(JSON.stringify(imported.body)).not.toContain(passphrase);
    const saved = (await store.read()).keys[0];
    expect(entries).toEqual([{ id: saved.passphraseCredentialId, integrationID: 'openchamber-git-ssh',
      label: 'Git SSH key', value: { type: 'key', key: passphrase }, activate: false }]);
    expect(await fs.readFile(saved.privateKeyPath)).toEqual(await fs.readFile(record.privateKeyPath));
    expect(await fs.readFile(filePath, 'utf8')).not.toContain(passphrase);
    await expect(run('ssh-keygen', ['-y', '-P', '', '-f', saved.privateKeyPath])).rejects.toThrow();
    const intent = { mode: 'managed', credentialId: imported.body.selectedCredential.credentialId,
      operationId: 'encrypted_execution', endpoint: { protocol: 'ssh', host: 'example.com', path: 'team/repo.git' } };
    const reopenResolver = () => createGitCredentialResolver({
      lookupManagedSshKey: createManagedSshCredentialStore({ filePath }).lookup, snapshotRoot,
      passphrases: createSshPassphraseStore({ list: async () => entries }),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resolved = await reopenResolver().resolve(intent);
      try {
        const windows = process.platform === 'win32';
        const helperPath = `${resolved.key.privateKeyPath}.askpass${windows ? '.ps1' : ''}`;
        expect(await fs.readFile(helperPath, 'utf8')).not.toContain(passphrase);
        expect(resolved.key.askpassEnv.SSH_ASKPASS).not.toContain(passphrase);
        let keygen = 'ssh-keygen';
        if (windows) {
          keygen = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe');
          expect(resolved.key.askpassEnv.SSH_ASKPASS).toContain('-WindowStyle Hidden');
          expect(resolved.key.askpassEnv.OPENCHAMBER_GIT_SSH_EXECUTABLE).toBe(path.join(path.dirname(keygen), 'ssh.exe'));
        }
        const publicKey = await run(keygen, ['-y', '-f', resolved.key.privateKeyPath], {
          env: { ...process.env, ...resolved.key.askpassEnv },
        });
        expect(publicKey.stdout).toContain('ssh-ed25519');
      } finally {
        expect(await resolved.key.cleanup()).toBe(true);
      }
      expect(await fs.readdir(snapshotRoot)).toEqual([]);
    }
    entries[0].value.key = 'incorrect saved passphrase';
    await expect(reopenResolver().resolve(intent)).rejects.toMatchObject({ code: 'SSH_KEY_UNVERIFIABLE' });
    expect(await fs.readdir(snapshotRoot)).toEqual([]);
    entries.length = 0;
    await expect(reopenResolver().resolve(intent)).rejects.toMatchObject({ code: 'SSH_KEY_UNVERIFIABLE' });
  });

  it.each(['credential', 'inventory'])('rolls back the encrypted copy and saved passphrase after a failed %s write', async (failure) => {
    const values = new Map();
    const passphrases = { create: async (id, value) => {
      values.set(id, value);
      if (failure === 'credential') throw new Error('store denied');
    },
      read: async (id) => values.get(id), remove: async (id) => { values.delete(id); } };
    const context = await fixture();
    await run('ssh-keygen', ['-p', '-P', '', '-N', 'fixture-passphrase', '-f', context.record.privateKeyPath]);
    const inventory = createManagedSshInventory({ ...context, passphrases,
      store: { ...context.store, append: async () => { throw new Error('store denied'); } } });
    const candidate = (await inventory.discover({ passphrase: 'fixture-passphrase' })).candidates[0];
    await expect(inventory.import({ candidateId: candidate.candidateId, expectedFingerprint: candidate.fingerprint,
      confirmed: true, passphrase: 'fixture-passphrase' })).rejects.toThrow('store denied');
    expect(values.size).toBe(0);
    expect(await fs.readdir(context.managedKeyRoot)).toEqual([]);
    expect(await fs.readdir(context.snapshotRoot)).toEqual([]);
  });

  it('discovers keys on a runtime whose directory close returns no promise', async () => {
    // Bun's Dir.close() returns undefined where Node returns a promise, and the
    // async iterator has already closed the directory. Assuming a promise threw
    // before any key was seen, which broke discovery in the Docker image.
    const { discoveryRoot, inventory } = await fixture({
      fsImpl: {
        ...fs,
        opendir: async (target) => {
          const directory = await fs.opendir(target);
          return { [Symbol.asyncIterator]: () => directory[Symbol.asyncIterator](), close: () => undefined };
        },
      },
    });
    expect(discoveryRoot).toContain('.ssh');

    const result = await inventory.discover();
    expect(result.status).toBe('discovered');
    expect(result.candidates.map((candidate) => candidate.label)).toContain('id_ed25519');
  });

  it('binds only an existing verified SSH reference to both exact endpoints, without provider accounts', async () => {
    const { record, store, inventory, root } = await fixture();
    await store.replace([record]);
    const endpoint = (rawUrl) => ({ rawUrl, displayUrl: rawUrl, fingerprint: fingerprintRemoteUrl(rawUrl) });
    const ssh = endpoint('git@example.com:team/repo.git');
    let remote = { name: 'origin', fetch: ssh, push: ssh };
    const repository = () => ({ supported: true, repositoryId: 'repo_one', configRevision: 'revision_one', bare: false, remotes: [remote] });
    const bindings = createBindingStore({ filePath: path.join(root, 'bindings.json') });
    const service = createBindingService({ store: bindings, resolveRepository: async () => repository(),
      resolveTransportRepository: async () => repository(), validateManagedSshCredential: inventory.assertAvailable,
      readTransportAccount: () => { throw new Error('Must not use provider auth'); },
    });
    const input = { directory: '/fixture/repo', expectedRepositoryId: 'repo_one', expectedRevision: 0,
      expectedConfigRevision: 'revision_one', expectedFetchFingerprint: ssh.fingerprint, expectedPushFingerprint: ssh.fingerprint,
      remote: 'origin', transport: 'ssh', sshCredentialId: createSshCredentialReference(record.id) };
    for (const extra of [{ sshCredentialId: '/arbitrary/key' }, { sshCredentialId: createSshCredentialReference('missing') },
      { credentialAccount: {} }, { privateKeyPath: record.privateKeyPath }]) {
      await expect(service.configureTransportBinding({ ...input, ...extra })).rejects.toThrow();
    }
    const result = await service.configureTransportBinding(input);
    expect(result).toMatchObject({ revision: 1, binding: { providers: [], auxiliary: [], remotes: [
      { name: 'origin', mode: 'managed', credentialId: input.sshCredentialId, readiness: 'ready' },
    ] } });
    expect(JSON.stringify(result)).not.toContain(record.privateKeyPath);
    remote = { ...remote, push: endpoint('https://example.com/team/repo.git') };
    await expect(service.configureTransportBinding({ ...input, expectedRevision: 1, expectedPushFingerprint: remote.push.fingerprint }))
      .rejects.toThrow('require SSH endpoints');
    expect((await bindings.read('repo_one')).revision).toBe(1);
  });

  it('persists the exact SSH clone grant at revision 1 and rejects endpoint or credential protocol mismatches', async () => {
    const { record, root } = await fixture();
    const approvedEndpoint = 'git@example.com:team/repo.git';
    const endpoint = { rawUrl: approvedEndpoint, displayUrl: approvedEndpoint, fingerprint: fingerprintRemoteUrl(approvedEndpoint) };
    let push = endpoint;
    const store = createBindingStore({ filePath: path.join(root, 'clone-bindings.json') });
    const service = createBindingService({ store, resolveTransportRepository: async () => ({ supported: true,
      repositoryId: 'repo_clone', configRevision: 'config', bare: false, remotes: [{ name: 'origin', fetch: endpoint, push }],
    }) });
    const input = { directory: '/fixture/clone', approvedEndpoint, transportMode: 'managed', credentialId: createSshCredentialReference(record.id) };
    await expect(service.bindClonedRepository({ ...input, approvedEndpoint: 'https://example.com/team/repo.git' })).rejects.toThrow('protocol');
    push = { ...endpoint, rawUrl: 'git@example.com:other/repo.git' };
    await expect(service.bindClonedRepository(input)).rejects.toThrow('differ');
    expect((await store.read('repo_clone')).revision).toBe(0);
    push = endpoint;
    const result = await service.bindClonedRepository(input);
    expect(result).toMatchObject({ revision: 1, binding: { providers: [], auxiliary: [], remotes: [
      { name: 'origin', mode: 'managed', credentialId: input.credentialId, readiness: 'ready' },
    ] } });
  });

  it('discovers and imports only opaque verified metadata after exact confirmation', async () => {
    const { record, store, inventory, filePath, snapshotRoot, managedKeyRoot, app } = await fixture();
    expect(await inventory.inventory()).toMatchObject({ status: 'available', credentials: [] });
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const discovery = await request(app).post('/api/git/managed-ssh-credentials').send({ operation: 'discover' }).expect(200);
    expect(discovery.headers['cache-control']).toBe('no-store');
    expect(discovery.body).toMatchObject({ status: 'discovered', truncated: false, candidates: [
      { label: 'id_ed25519', fingerprint: record.fingerprint, capability: { status: 'ready' } },
    ] });
    const candidate = discovery.body.candidates[0];
    expect(candidate.candidateId).toMatch(/^ssh_candidate_[A-Za-z0-9_]+$/);
    expect(JSON.stringify(discovery.body)).not.toContain(record.privateKeyPath);
    expect(JSON.stringify(discovery.body)).not.toContain('private-comment-canary');
    expect(JSON.stringify(discovery.body)).not.toContain('PRIVATE KEY');
    expect((await request(app).post('/api/git/managed-ssh-credentials').send({ operation: 'import',
      candidateId: candidate.candidateId, expectedFingerprint: `SHA256:${'z'.repeat(43)}`, confirmed: true }).expect(200)).body)
      .toEqual({ status: 'rejected', reason: 'fingerprint-mismatch' });
    const imported = await request(app).post('/api/git/managed-ssh-credentials').send({ operation: 'import',
      candidateId: candidate.candidateId, expectedFingerprint: candidate.fingerprint, confirmed: true }).expect(200);
    expect(imported.body).toMatchObject({ status: 'imported', selectedCredential: {
      label: 'SSH', fingerprint: record.fingerprint, capability: { status: 'ready' },
    }, credentials: [{ fingerprint: record.fingerprint }] });
    expect(imported.body.selectedCredential.credentialId).toMatch(/^ocgit:v1:ssh:/);
    const persisted = (await store.read()).keys[0];
    expect(persisted.privateKeyPath.startsWith(`${managedKeyRoot}${path.sep}`)).toBe(true);
    expect(persisted.privateKeyPath).not.toBe(record.privateKeyPath);
    expect(JSON.stringify(await store.read())).not.toContain(record.privateKeyPath);
    expect((await fs.stat(managedKeyRoot)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(persisted.privateKeyPath)).mode & 0o777).toBe(0o600);
    expect((await request(app).post('/api/git/managed-ssh-credentials').send({ operation: 'import',
      candidateId: candidate.candidateId, expectedFingerprint: candidate.fingerprint, confirmed: true }).expect(200)).body)
      .toEqual({ status: 'rejected', reason: 'candidate-expired' });
    expect(await fs.readdir(snapshotRoot)).toEqual([]);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('does not recurse or follow symlinks and reports encrypted or permissive likely keys safely', async () => {
    const { root, discoveryRoot, inventory } = await fixture();
    const nested = path.join(discoveryRoot, 'nested');
    await fs.mkdir(nested);
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(nested, 'id_nested')]);
    await fs.symlink(path.join(discoveryRoot, 'id_ed25519'), path.join(discoveryRoot, 'id_link'));
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'fixture-passphrase', '-f', path.join(discoveryRoot, 'id_encrypted')]);
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(discoveryRoot, 'id_permissive')]);
    await fs.chmod(path.join(discoveryRoot, 'id_permissive'), 0o644);
    await fs.writeFile(path.join(discoveryRoot, 'config'), 'Host *\n  IdentityFile /outside/key\n', { mode: 0o600 });

    const result = await inventory.discover();
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(['id_ed25519', 'id_encrypted', 'id_permissive']);
    expect(result.candidates.map((candidate) => candidate.capability)).toEqual([
      { status: 'ready' },
      { status: 'unavailable', reason: 'encrypted-or-unverifiable' },
      { status: 'unavailable', reason: 'insecure-permissions' },
    ]);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('expires candidates, rejects host-file changes, and removes a managed copy when the locked store write fails', async () => {
    let clock = Date.now();
    const expiring = await fixture({ now: () => clock, candidateTtlMs: 10 });
    const discovered = await expiring.inventory.discover();
    clock += 11;
    await expect(expiring.inventory.import({ operation: 'import', candidateId: discovered.candidates[0].candidateId,
      expectedFingerprint: discovered.candidates[0].fingerprint, confirmed: true }))
      .resolves.toEqual({ status: 'rejected', reason: 'candidate-expired' });

    const changed = await fixture();
    const stale = await changed.inventory.discover();
    const replacement = path.join(changed.root, 'replacement');
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', replacement]);
    await fs.copyFile(replacement, changed.record.privateKeyPath);
    await expect(changed.inventory.import({ operation: 'import', candidateId: stale.candidates[0].candidateId,
      expectedFingerprint: stale.candidates[0].fingerprint, confirmed: true }))
      .resolves.toEqual({ status: 'rejected', reason: 'candidate-changed' });

    const rollback = await fixture();
    const failingInventory = createManagedSshInventory({
      store: { ...rollback.store, append: async () => { throw new Error('store denied'); } },
      snapshotRoot: rollback.snapshotRoot,
      discoveryRoot: rollback.discoveryRoot,
      managedKeyRoot: rollback.managedKeyRoot,
    });
    const retryCandidate = (await failingInventory.discover()).candidates[0];
    await expect(failingInventory.import({ operation: 'import', candidateId: retryCandidate.candidateId,
      expectedFingerprint: retryCandidate.fingerprint, confirmed: true })).rejects.toThrow('store denied');
    expect(await fs.readdir(rollback.managedKeyRoot)).toEqual([]);
  });

  it('rejects a replaced private key despite a stale public key and fingerprint, at inventory and execution', async () => {
    const { record, store, inventory, root, snapshotRoot } = await fixture();
    await store.replace([record]);
    const reference = createSshCredentialReference(record.id);
    await inventory.assertAvailable(reference);
    const replacement = path.join(root, 'replacement');
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', replacement]);
    await fs.copyFile(replacement, record.privateKeyPath);
    expect((await inventory.inventory()).credentials[0].capability).toEqual({ status: 'unavailable', reason: 'fingerprint-mismatch' });
    expect(await inventory.presentation(reference)).toBeNull();
    await expect(inventory.assertAvailable(reference)).rejects.toThrow('unavailable');
    const resolver = createGitCredentialResolver({ lookupManagedSshKey: store.lookup, snapshotRoot });
    await expect(resolver.resolve({ mode: 'managed', credentialId: reference, operationId: 'execution',
      endpoint: { protocol: 'ssh', host: 'example.com', path: 'team/repo.git' } })).rejects.toThrow('fingerprint does not match');
    expect(await fs.readdir(snapshotRoot)).toEqual([]);
  });

  it('keeps healthy keys alongside missing and encrypted keys, without agent or passphrase fallback', async () => {
    const { record, root, store, inventory } = await fixture();
    const encrypted = path.join(root, 'encrypted');
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'fixture-passphrase', '-f', encrypted]);
    await store.replace([record, { ...record, id: 'missing', privateKeyPath: path.join(root, 'missing') },
      { ...record, id: 'encrypted', privateKeyPath: encrypted }]);
    expect((await inventory.inventory()).credentials.map((entry) => entry.capability)).toEqual([
      { status: 'ready' }, { status: 'unavailable', reason: 'unreadable' }, { status: 'unavailable', reason: 'encrypted-or-unverifiable' },
    ]);
    await expect(inventory.assertAvailable('/arbitrary/key')).rejects.toThrow('reference is invalid');
    await expect(inventory.assertAvailable(createSshCredentialReference('absent'))).rejects.toThrow('unavailable');
  });

  it('rejects raw paths, key content, unconfirmed imports, malformed stores and read failures without leaking details', async () => {
    const { record, store, app, filePath } = await fixture();
    for (const body of [{ operation: 'inventory', path: record.privateKeyPath }, { operation: 'discover', roots: ['/'] },
      { operation: 'inventory', passphrase: 'secret' }, { operation: 'discover', passphrase: 123 },
      { operation: 'discover', passphrase: 'a\nb' }, { operation: 'discover', passphrase: 'x'.repeat(1025) },
      { operation: 'import', privateKey: 'PRIVATE KEY' },
      { operation: 'import', candidateId: 'candidate', expectedFingerprint: record.fingerprint, confirmed: false }]) {
      const response = await request(app).post('/api/git/managed-ssh-credentials').send(body).expect(400);
      expect(response.body).toEqual({ code: 'INVALID_REQUEST', error: 'Invalid managed SSH inventory request' });
    }
    await store.replace([record]);
    await fs.writeFile(filePath, 'private-invalid-canary');
    const response = await request(app).post('/api/git/managed-ssh-credentials').send({ operation: 'inventory' }).expect(500);
    expect(response.body).toEqual({ code: 'UNKNOWN', error: 'Managed SSH inventory could not be read' });
    expect(response.body).not.toHaveProperty('credentials');
    const failing = createManagedSshInventory({ store: { read: async () => { throw new Error('denied'); } },
      snapshotRoot: path.join(record.privateKeyPath, 'snapshots'), discoveryRoot: path.dirname(record.privateKeyPath),
      managedKeyRoot: path.join(path.dirname(record.privateKeyPath), 'managed') });
    await expect(failing.inventory()).rejects.toThrow('denied');
  });

  it('does not encode path-shaped store IDs into public references or report ready after cleanup failure', async () => {
    const { record, store, inventory, snapshotRoot } = await fixture();
    await store.replace([{ ...record, id: record.privateKeyPath }]);
    await expect(inventory.inventory()).rejects.toThrow('ID is invalid');
    await expect(inspectManagedSshCredential(record, { snapshotRoot, fsImpl: { ...fs,
      rm: async () => { throw new Error('cleanup denied'); },
    } })).rejects.toThrow('cleanup failed');
  });

  it('settles concurrent short-lived key-verification subprocesses and cleans every snapshot', async () => {
    const { record, snapshotRoot } = await fixture();
    for (let round = 0; round < 4; round += 1) {
      const results = await Promise.all(Array.from({ length: 4 }, () => inspectManagedSshCredential(record, { snapshotRoot })));
      expect(results).toEqual(Array.from({ length: 4 }, () => ({ status: 'ready' })));
    }
    expect(await fs.readdir(snapshotRoot)).toEqual([]);
  });
});
