import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fingerprintRemoteUrl } from '../source-control/url-redaction.js';
import { createHttpsCredentialReference, createSshCredentialReference } from './credential-resolver.js';
import { createNetworkOperations } from './network-operations.js';
import { createBindingService } from '../source-control/binding-service.js';
import { createBindingStore } from '../source-control/binding-storage.js';
import { resolveRepositoryIdentity } from '../source-control/repository-identity.js';

const SHA = 'a'.repeat(40);
const ENDPOINT = 'https://example.com/owner/repository.git';
const CLONE_ACCOUNT = { provider: 'gitlab', instance: 'https://example.com', accountId: 'account-one' };
const CLONE_CREDENTIAL = {
  id: CLONE_ACCOUNT.accountId,
  credentialId: CLONE_ACCOUNT.accountId,
  credentialRevision: 3,
  providerUserId: 'https://example.com#42',
  status: 'valid',
  token: 'clone-secret',
};
const temporaryDirectories = [];
const execFileAsync = promisify(execFile);

const createLocalRepository = async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-local-integration-'));
  temporaryDirectories.push(parent);
  const directory = path.join(parent, 'repository');
  const env = { ...process.env, HOME: parent, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_LFS_SKIP_SMUDGE: '1' };
  await execFileAsync('git', ['init', '-b', 'published', directory], { env });
  const git = async (...args) => (await execFileAsync('git', args, { cwd: directory, env })).stdout.trim();
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(directory, 'README.md'), 'ordinary content\n');
  await git('add', '.');
  await git('commit', '-m', 'base');
  return { parent, directory, env, git };
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const request = (operation = 'push', overrides = {}) => ({
  operation,
  directory: '/repository',
  repositoryId: 'repo_one',
  bindingRevision: 2,
  configRevision: 'config_one',
  remote: {
    name: 'publish',
    endpoint: { displayUrl: ENDPOINT, fingerprint: fingerprintRemoteUrl(ENDPOINT) },
  },
  sourceRef: 'refs/heads/feature',
  destinationRef: 'refs/heads/published',
  transportMode: 'managed',
  ...overrides,
});
const syncRequest = (overrides = {}) => ({
  operation: 'sync',
  directory: '/repository',
  repositoryId: 'repo_one',
  bindingRevision: 2,
  configRevision: 'config_one',
  fetch: {
    remote: {
      name: 'upstream',
      endpoint: { displayUrl: ENDPOINT, fingerprint: fingerprintRemoteUrl(ENDPOINT) },
    },
    sourceRef: 'refs/heads/main',
    destinationRef: 'refs/remotes/upstream/main',
    transportMode: 'managed',
  },
  pull: { destinationRef: 'refs/heads/published' },
  push: {
    remote: {
      name: 'origin',
      endpoint: { displayUrl: ENDPOINT, fingerprint: fingerprintRemoteUrl(ENDPOINT) },
    },
    sourceRef: 'refs/heads/published',
    destinationRef: 'refs/heads/published',
    transportMode: 'managed',
  },
  ...overrides,
});

const createSpawn = (results = [], responder) => {
  const calls = [];
  const children = [];
  const spawnImpl = vi.fn((file, args, options) => {
    const child = new EventEmitter();
    child.pid = 10_000 + children.length;
    child.exitCode = null;
    child.killed = false;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const result = responder?.({ file, args, options, callIndex: calls.length }) ?? results.shift() ?? { code: 0 };
    const close = (code = result.code ?? 0, signal = null) => {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      child.emit('close', code, signal);
    };
    child.kill = vi.fn((signal = 'SIGTERM') => {
      child.killed = true;
      queueMicrotask(() => close(null, signal));
      return true;
    });
    child.unref = vi.fn();
    calls.push({ file, args, options, child });
    children.push(child);
    if (!result.manual) queueMicrotask(async () => {
      await result.onSpawn?.({ file, args, options, child });
      if (result.stdout) child.stdout.write(result.stdout);
      if (result.stderr) child.stderr.write(result.stderr);
      close();
    });
    return child;
  });
  return { spawnImpl, calls, children };
};

const setup = ({ mode = 'managed', transport = 'https', credentialId = 'opaque-credential', keyPath = '/keys/selected key', spawnResults, spawnResponder, env, timeoutMs, fsImpl, validateGitIdentity = async () => {}, validateManagedSshCredential, resolveSourceControlAccount = vi.fn(async () => CLONE_CREDENTIAL), applyGitIdentity, bindClonedRepository = async () => {}, inspectMergeState, enumerateManagedConfigKeys = vi.fn(async () => []), resolveChangeRequestSource, validateGitAuxiliaryContext, onCheckoutHydrated, auditStore, operationStore, authorityFor } = {}) => {
  const authority = {
    endpoint: transport === 'ssh' ? 'git@example.com:owner/repository.git' : ENDPOINT,
    endpointFingerprint: fingerprintRemoteUrl(transport === 'ssh' ? 'git@example.com:owner/repository.git' : ENDPOINT),
    transportMode: mode,
    transportRevision: 'transport_one',
  };
  if (mode === 'managed') authority.credentialId = credentialId;
  const validateGitTransportContext = vi.fn(async (input) => authorityFor?.(input, authority) ?? authority);
  const resolveRef = vi.fn(async () => SHA);
  const resolveSymbolicRef = vi.fn(async () => 'refs/heads/published');
  const credential = transport === 'ssh'
    ? { mode: 'managed', transport: 'ssh', key: { privateKeyPath: keyPath, sourcePath: '/keys/source', fingerprint: `SHA256:${'a'.repeat(43)}`, cleanup: vi.fn() } }
    : {
      mode: 'managed', transport: 'https', username: 'oauth2', password: 'top-secret',
      actor: { provider: 'gitlab', instance: 'https://example.com', accountId: 'https://example.com#42', login: null },
      allowedEndpoint: { protocol: 'https', host: 'example.com', port: 443, path: 'owner/repository.git' },
    };
  const credentialResolver = { resolve: vi.fn(async ({ mode: requestedMode }) => requestedMode === 'system' ? { mode: 'system' } : credential) };
  const credentialBroker = {
    start: vi.fn(async () => {}),
    issue: vi.fn(() => ({ gitConfigArgs: ['-c', 'credential.helper=!broker nonce'], revoke: vi.fn() })),
    revoke: vi.fn(),
  };
  const spawned = createSpawn(spawnResults, (call) => {
    const response = spawnResponder?.(call);
    if (call.args.includes('rev-parse') && call.args.includes('HEAD')
      && (response === undefined || response.code === 0 && response.stdout === undefined)) {
      return { ...response, code: 0, stdout: SHA };
    }
    return response ?? (call.args.includes('^filter\\..*\\.(process|smudge|clean|required)$')
      || call.args.includes('HEAD:.gitmodules') || call.args.includes('ls-tree') || call.args.includes('ls-files') || call.args.includes('rev-list')
      ? { code: 0 } : undefined);
  });
  const service = createNetworkOperations({
    validateGitTransportContext,
    validateManagedSshCredential,
    resolveSourceControlAccount,
    systemPushAcknowledgements: {
      isAcknowledged: vi.fn(async () => true),
      acknowledge: vi.fn(async () => {}),
    },
    resolveRef,
    resolveSymbolicRef,
    credentialResolver,
    credentialBroker,
    runtimeIdentity: { id: 'runtime_one', platform: 'web' },
    idFactory: () => 'git_operation_one',
    spawnImpl: spawned.spawnImpl,
    inheritedEnv: env ?? {},
    platform: 'darwin',
    timeoutMs,
    fsImpl,
    validateGitIdentity,
    applyGitIdentity,
    bindClonedRepository,
    inspectMergeState,
    enumerateManagedConfigKeys,
    resolveChangeRequestSource,
    validateGitAuxiliaryContext,
    onCheckoutHydrated,
    auditStore,
    operationStore,
  });
  return { service, authority, validateGitTransportContext, resolveRef, resolveSymbolicRef, credentialResolver, credentialBroker, ...spawned };
};

const createLfsPublicationFixture = async ({ transport = 'https', timeoutMs, ordinary = false } = {}) => {
    const fixture = await createLocalRepository();
    const oid = 'd'.repeat(64);
    const lfsEndpoint = 'https://media.example.net/storage';
    await fs.writeFile(path.join(fixture.directory, 'asset.bin'), ordinary ? 'ordinary content' : `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12\n`);
    await fs.writeFile(path.join(fixture.directory, '.lfsconfig'), `[lfs]\nurl = ${lfsEndpoint}\n`);
    await fixture.git('add', '.');
    await fixture.git('commit', '-m', 'pointer');
    const pinned = await fixture.git('rev-parse', 'HEAD');
    await fixture.git('branch', 'feature');
    await fixture.git('reset', '--hard', 'HEAD^');
    const calls = [];
    const uploadResult = { code: 0 };
    const refResult = { code: 0 };
    const binaryResult = { code: 0, stdout: 'git-lfs/3.7.1\n' };
    const transfers = createSpawn([], ({ args }) => args.includes('version') ? binaryResult : args.includes('lfs') ? uploadResult : args.includes('push') ? refResult : { code: 0 });
    const parentEndpoint = transport === 'https' ? ENDPOINT : 'git@example.com:owner/repository.git';
    const validateGitAuxiliaryContext = vi.fn(async ({ rawEndpoint }) => ({
      endpoint: rawEndpoint, endpointFingerprint: fingerprintRemoteUrl(rawEndpoint),
      transportMode: 'managed', credentialId: 'lfs-only', transportRevision: 'transport_one',
    }));
    const credentialResolver = { resolve: vi.fn(async ({ credentialId, endpoint }) => credentialId !== 'lfs-only' && transport === 'ssh'
      ? { mode: 'managed', transport: 'ssh', key: { privateKeyPath: '/private/parent-key', sourcePath: '/private/source-key', fingerprint: `SHA256:${'a'.repeat(43)}`, cleanup: vi.fn() } }
      : ({
      mode: 'managed', transport: 'https', username: 'oauth2', password: credentialId === 'lfs-only' ? 'lfs-secret' : 'parent-secret',
      actor: { provider: 'github', instance: 'github.com', accountId: credentialId, login: null },
      allowedEndpoint: endpoint,
    })) };
    const broker = { start: vi.fn(async () => {}), issue: vi.fn(() => ({ gitConfigArgs: [], revoke: vi.fn() })), revoke: vi.fn() };
    const auditStore = { plan: vi.fn(async (record) => ({ status: 'planned', record })), start: vi.fn(async () => {}), finish: vi.fn(async () => {}) };
    const validateGitTransportContext = vi.fn(async () => ({ endpoint: parentEndpoint, endpointFingerprint: fingerprintRemoteUrl(parentEndpoint),
      transportMode: 'managed', credentialId: 'opaque-credential', transportRevision: 'transport_one' }));
    const service = createNetworkOperations({
      validateGitTransportContext,
      validateGitAuxiliaryContext, credentialResolver, credentialBroker: broker,
      systemPushAcknowledgements: { isAcknowledged: async () => true, acknowledge: async () => {} },
      runtimeIdentity: { id: 'fixture', platform: 'web' }, inheritedEnv: fixture.env,
      timeoutMs, auditStore,
      spawnImpl: (binary, args, options) => {
        calls.push({ args, options });
        if (args.includes('lfs') || args.includes('push') || args.includes('fetch')) {
          return transfers.spawnImpl(binary, args, options);
        }
        return spawn(binary, args, options);
      },
    });
    const pushRequest = request('push', { directory: fixture.directory,
      remote: { name: 'publish', endpoint: { displayUrl: parentEndpoint, fingerprint: fingerprintRemoteUrl(parentEndpoint) } } });
    return { ...fixture, service, calls, oid, lfsEndpoint, pinned, parentEndpoint, pushRequest,
      validateGitTransportContext, validateGitAuxiliaryContext, credentialResolver, broker, auditStore, uploadResult, refResult, binaryResult, transfers };
};

describe('Git network operations', () => {
  it('executes anonymous fetch without resolver or broker and audits an anonymous marker', async () => {
    const auditStore = { plan: vi.fn(async () => {}), start: vi.fn(async () => {}), finish: vi.fn(async () => {}) };
    const operation = setup({ mode: 'anonymous', auditStore,
      env: { PATH: '/bin', GIT_ASKPASS: '/ambient/askpass', SSH_AUTH_SOCK: '/ambient/agent',
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: ambient', HTTPS_PROXY: 'ambient' },
      enumerateManagedConfigKeys: async () => ['http.https://example.com/owner/.extraheader', 'http.sslcert', 'http.cookiefile', 'credential.helper'],
    });
    const plan = await operation.service.plan(request('fetch', { transportMode: 'anonymous' }));
    const result = await operation.service.execute(plan.operationId);
    expect(result.state).toBe('succeeded');
    expect(result.transport).toEqual({ mode: 'anonymous', verification: { status: 'anonymous' } });
    expect(result.completedSteps).not.toContain('authenticated');
    expect(operation.credentialResolver.resolve).not.toHaveBeenCalled();
    expect(operation.credentialBroker.start).not.toHaveBeenCalled();
    expect(operation.credentialBroker.issue).not.toHaveBeenCalled();
    const transfer = operation.calls.find((call) => call.args.includes('fetch'));
    expect(transfer.options.env).toMatchObject({ GIT_ALLOW_PROTOCOL: 'https', HOME: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
    expect(JSON.stringify(transfer)).not.toContain('ambient');
    expect(transfer.args).toContain('http.https://example.com/owner/.extraheader=');
    expect(transfer.args).toContain('http.sslcert=');
    expect(auditStore.plan).toHaveBeenCalledWith(expect.objectContaining({ providerAccountId: null, transportReference: { kind: 'anonymous' } }));
    expect(JSON.stringify(result)).not.toMatch(/credentialId|accountId|top-secret/);
  });

  it('does not transfer anonymous writes or reuse a changed endpoint', async () => {
    const operation = setup({ mode: 'anonymous' });
    const sync = syncRequest();
    sync.push.transportMode = 'anonymous';
    const deletion = request('delete-remote-branch', { transportMode: 'anonymous' });
    delete deletion.sourceRef;
    for (const input of [request('push', { transportMode: 'anonymous' }), deletion, sync]) {
      await expect(operation.service.plan(input)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(operation.calls).toHaveLength(0);
    const plan = await operation.service.plan(request('fetch', { transportMode: 'anonymous' }));
    operation.authority.endpoint = 'https://example.com/changed.git';
    expect(await operation.service.execute(plan.operationId)).toMatchObject({ state: 'conflicted', error: { code: 'REMOTE_CHANGED' } });
    expect(operation.calls).toHaveLength(0);
    expect(operation.credentialResolver.resolve).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not reuse anonymous parent authority for a submodule, exact grant=%s', async (granted) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-anonymous-submodule-'));
    temporaryDirectories.push(directory);
    const operation = setup({ mode: 'anonymous', validateGitAuxiliaryContext: async ({ rawEndpoint }) => {
      if (!granted) throw Object.assign(new Error('Missing exact grant'), { code: 'GIT_AUXILIARY_AUTHORIZATION_REQUIRED' });
      return { endpoint: rawEndpoint, endpointFingerprint: fingerprintRemoteUrl(rawEndpoint), transportMode: 'anonymous', transportRevision: 'one' };
    }, spawnResponder: ({ args }) => {
      if (args.includes('HEAD:.gitmodules')) return { code: 0, stdout: 'submodule.child.path\nvendor/child\0submodule.child.url\n../child.git\0' };
      if (args.includes('ls-tree')) return { code: 0, stdout: `160000 commit ${SHA}\tvendor/child\0` };
      return { code: 0 };
    } });
    const result = await operation.service.hydrateBoundCheckout({ directory, parentRemoteName: 'publish',
      repositoryAuthority: { repositoryId: 'repo_one', bindingRevision: 2, configRevision: 'config_one' } });
    expect(result.submodules[0]).toMatchObject(granted
      ? { status: 'succeeded' }
      : { status: 'authorization-required', error: { code: 'AUTHENTICATION_REQUIRED' } });
    expect(operation.calls.some((call) => call.args.includes('clone'))).toBe(granted);
    expect(operation.credentialResolver.resolve).not.toHaveBeenCalled();
    expect(operation.credentialBroker.start).not.toHaveBeenCalled();
  });

  it('clones, fetches and pulls public HTTPS with no ambient authentication, including after a challenge', async () => {
    const fixture = await createLocalRepository();
    const bare = path.join(fixture.parent, 'public.git');
    await execFileAsync('git', ['clone', '--bare', fixture.directory, bare], { env: fixture.env });
    await execFileAsync('git', ['--git-dir', bare, 'update-server-info'], { env: fixture.env });
    const key = path.join(fixture.parent, 'server.key');
    const cert = path.join(fixture.parent, 'server.crt');
    await execFileAsync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', cert]);
    const requests = [];
    let challenge = false;
    const server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, async (incoming, response) => {
      requests.push(incoming.headers);
      if (challenge) { response.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end(); return; }
      const file = path.resolve(fixture.parent, `.${new URL(incoming.url, 'https://localhost').pathname}`);
      if (!file.startsWith(`${bare}/`)) { response.writeHead(404).end(); return; }
      try { response.end(await fs.readFile(file)); } catch { response.writeHead(404).end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = `https://127.0.0.1:${server.address().port}/public.git`;
      const marker = path.join(fixture.parent, 'ambient-called');
      const helper = path.join(fixture.parent, 'ambient-helper');
      await fs.writeFile(helper, `#!/bin/sh\ntouch '${marker}'\n`);
      await fs.chmod(helper, 0o700);
      await fs.writeFile(path.join(fixture.parent, '.netrc'), 'machine 127.0.0.1 login ambient password ambient-secret\n');
      const cookie = path.join(fixture.parent, 'cookies');
      await fs.writeFile(cookie, '127.0.0.1\tFALSE\t/\tTRUE\t2147483647\tambient-cookie\tsecret\n');
      const globalConfig = path.join(fixture.parent, '.gitconfig');
      await fs.writeFile(globalConfig, `[credential]\nhelper = ${helper}\n[http]\nextraHeader = Authorization: Bearer ambient-global\ncookieFile = ${cookie}\n`);
      const credentialResolver = { resolve: vi.fn(async () => { throw new Error('Credential resolver must not run'); }) };
      const binding = createBindingService({ store: createBindingStore({ filePath: path.join(fixture.parent, 'bindings.json') }), resolveRepository: resolveRepositoryIdentity });
      const destination = path.join(fixture.parent, 'checkout');
      const service = createNetworkOperations({
        validateGitTransportContext: async () => ({ endpoint, endpointFingerprint: fingerprintRemoteUrl(endpoint), transportMode: 'anonymous', transportRevision: 'one' }),
        systemPushAcknowledgements: { isAcknowledged: async () => false, acknowledge: async () => { throw new Error('No System acknowledgement'); } },
        credentialResolver, bindClonedRepository: binding.bindClonedRepository,
        validateGitAuxiliaryContext: binding.validateGitAuxiliaryContext,
        runtimeIdentity: { id: 'public-https-test', platform: 'web' },
        inheritedEnv: { ...fixture.env, HOME: fixture.parent, GIT_CONFIG_GLOBAL: globalConfig, GIT_ASKPASS: helper,
          SSH_ASKPASS: helper, SSH_AUTH_SOCK: marker, HTTPS_PROXY: 'http://127.0.0.1:1', GIT_TRACE_CURL: marker },
        // Only the fixture accepts its self-signed certificate. Production argv still enforces TLS.
        spawnImpl: (file, args, options) => spawn(file, args.some((arg) => ['fetch', 'clone'].includes(arg))
          ? ['-c', 'http.sslVerify=false', ...args.map((arg) => arg.endsWith('.sslVerify=true') || arg === 'http.sslVerify=true' ? arg.replace(/true$/, 'false') : arg)] : args, options),
      });
      const cloned = await service.plan({ operation: 'clone', remoteUrl: endpoint, destinationPath: destination, transportMode: 'anonymous' });
      const cloneResult = await service.execute(cloned.operationId);
      expect(cloneResult, JSON.stringify(cloneResult)).toMatchObject({ state: 'succeeded' });
      expect(await binding.get(destination)).toMatchObject({ revision: 1, binding: { remotes: [{ mode: 'anonymous' }] } });
      expect(await fs.readFile(path.join(destination, 'README.md'), 'utf8')).toBe('ordinary content\n');
      const included = path.join(fixture.parent, 'local-auth.config');
      await fs.writeFile(included, `[http "${endpoint}/"]\nextraHeader = Authorization: Bearer ambient-local\nextraHeader = PRIVATE-TOKEN: ambient-private\ncookieFile = ${cookie}\n[credential]\nhelper = ${helper}\n[core]\naskPass = ${helper}\n`);
      await execFileAsync('git', ['config', 'include.path', included], { cwd: destination, env: fixture.env });
      const remote = { name: 'origin', endpoint: { displayUrl: endpoint, fingerprint: fingerprintRemoteUrl(endpoint) } };
      for (const operation of ['fetch', 'pull']) {
        const planned = await service.plan(request(operation, { directory: destination, remote, transportMode: 'anonymous', sourceRef: 'refs/heads/published', destinationRef: operation === 'pull' ? 'refs/heads/published' : 'refs/remotes/origin/published' }));
        const result = await service.execute(planned.operationId);
        expect(result, JSON.stringify(result)).toMatchObject({ state: 'succeeded' });
      }
      challenge = true;
      const denied = await service.plan(request('fetch', { directory: destination, remote, transportMode: 'anonymous' }));
      expect(await service.execute(denied.operationId)).toMatchObject({ state: 'failed' });
      challenge = false;
      await execFileAsync('git', ['config', 'http.sslCert', '/missing/ambient-cert'], { cwd: destination, env: fixture.env });
      const certificatePlan = await service.plan(request('fetch', { directory: destination, remote, transportMode: 'anonymous' }));
      const certificateResult = await service.execute(certificatePlan.operationId);
      // Some Git/Curl builds reject an empty certificate reset rather than ignoring it. Never retry with host auth.
      expect(['succeeded', 'failed']).toContain(certificateResult.state);
      expect(JSON.stringify(certificateResult)).not.toContain('/missing/ambient-cert');
      expect(requests.length).toBeGreaterThan(3);
      for (const headers of requests) {
        expect(headers.authorization).toBeUndefined();
        expect(headers.cookie).toBeUndefined();
        expect(headers['private-token']).toBeUndefined();
      }
      expect(credentialResolver.resolve).not.toHaveBeenCalled();
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await new Promise((resolve) => server.close(resolve)); }
  }, 30_000);
  it.each(['https', 'ssh'])('uploads only pinned source LFS objects before publishing the %s Git ref', async (transport) => {
    const { service, calls, oid, lfsEndpoint, pinned, parentEndpoint, pushRequest, validateGitAuxiliaryContext, credentialResolver, auditStore, broker } = await createLfsPublicationFixture({ transport });
    const planned = await service.plan(pushRequest);
    const result = await service.execute(planned.operationId);
    expect(result.state).toBe('succeeded');
    const publications = calls.filter((call) => call.args.includes('push'));
    expect(publications).toHaveLength(2);
    expect(publications[0].args.slice(publications[0].args.indexOf('lfs'))).toEqual(['lfs', 'push', '--object-id', 'openchamber-lfs', oid]);
    expect(publications[0].args).not.toContain('--all');
    expect(publications[0].args).toContain(`lfs.pushurl=${lfsEndpoint}`);
    expect(publications[1].args.slice(-4)).toEqual(['push', '--', parentEndpoint, `${pinned}:refs/heads/published`]);
    expect(validateGitAuxiliaryContext).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'lfs', rawEndpoint: lfsEndpoint, directory: expect.any(String), repositoryId: 'repo_one',
    }));
    expect(credentialResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 'lfs-only' }));
    expect(JSON.stringify(result)).not.toMatch(/lfs-secret|parent-secret|media\.example/);
    expect(publications[0].options.env).not.toHaveProperty('OPENCHAMBER_GIT_SSH_KEY');
    expect(publications[0].options.env.HOME).toBe(publications[0].options.cwd);
    await expect(fs.stat(publications[0].options.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(broker.revoke).toHaveBeenCalledWith(`${planned.operationId}:lfs-upload`);
    expect(broker.issue.mock.calls.map(([input]) => input.operationId)).toEqual(transport === 'https'
      ? [`${planned.operationId}:lfs-upload`, planned.operationId] : [`${planned.operationId}:lfs-upload`]);
    expect(auditStore.plan).toHaveBeenCalledWith(expect.objectContaining({
      id: `git:${planned.operationId}:lfs-upload`, transportReference: { kind: 'managed', credentialId: 'lfs-only' },
      target: { kind: 'git-network', operation: 'push', remotes: [{ role: 'push', name: 'lfs-upload',
        endpointFingerprint: fingerprintRemoteUrl(lfsEndpoint), sourceRef: 'refs/heads/feature' }] },
    }));
    expect(JSON.stringify(auditStore.plan.mock.calls)).not.toMatch(/https:\/\/|lfs-secret|parent-secret/);
  });

  it('publishes ordinary history without probing git-lfs or adding a network transfer', async () => {
    const fixture = await createLfsPublicationFixture({ ordinary: true });
    fixture.binaryResult.code = 1;
    fixture.binaryResult.stdout = '';
    const plan = await fixture.service.plan(fixture.pushRequest);
    expect((await fixture.service.execute(plan.operationId)).state).toBe('succeeded');
    expect(fixture.calls.filter((call) => call.args.includes('push'))).toHaveLength(1);
    expect(fixture.calls.some((call) => call.args.includes('lfs'))).toBe(false);
    expect(fixture.validateGitAuxiliaryContext).not.toHaveBeenCalled();
    expect(fixture.auditStore.plan).toHaveBeenCalledOnce();
  });

  it('uploads through real git-lfs using only the exact LFS broker credential', async ({ skip }) => {
    const fixture = await createLocalRepository();
    try { await fixture.git('lfs', 'version'); } catch (error) {
      if (error.code === 1 && error.stderr.includes("'lfs' is not a git command")) {
        skip('git-lfs is not installed; real HTTPS upload verification requires the system client');
      }
      throw error;
    }
    const key = path.join(fixture.parent, 'server.key');
    const cert = path.join(fixture.parent, 'server.crt');
    await execFileAsync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', cert]);
    const data = Buffer.from('selected LFS object\n');
    const oid = crypto.createHash('sha256').update(data).digest('hex');
    const requests = [];
    const uploaded = [];
    let endpoint;
    const server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({ path: req.url, authorization: req.headers.authorization });
        if (req.headers.authorization !== `Basic ${Buffer.from('oauth2:lfs-fixture-secret').toString('base64')}`) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="lfs"' }).end();
          return;
        }
        if (req.url === '/storage/objects/batch') {
          const request = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(200, { 'content-type': 'application/vnd.git-lfs+json' }).end(JSON.stringify({
            // No `authenticated` flag: like GitLab, the upload href needs the same Basic credential as the batch call.
            transfer: 'basic', objects: request.objects.map((object) => ({ ...object,
              actions: { upload: { href: `${endpoint}/upload/${object.oid}` } } })),
          }));
        } else if (req.url === `/storage/upload/${oid}`) {
          uploaded.push(Buffer.concat(chunks));
          res.writeHead(200).end();
        } else res.writeHead(404).end();
      });
    });
    const broker = (await import('./credential-broker.js')).createGitCredentialBroker();
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      endpoint = `https://127.0.0.1:${server.address().port}/storage`;
      await fs.writeFile(path.join(fixture.directory, 'asset.bin'), `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${data.length}\n`);
      await fs.writeFile(path.join(fixture.directory, '.lfsconfig'), `[lfs]\nurl = ${endpoint}\n`);
      await fixture.git('add', '.');
      await fixture.git('commit', '-m', 'LFS source');
      await fixture.git('branch', 'feature');
      const storage = path.join(fixture.directory, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4));
      await fs.mkdir(storage, { recursive: true });
      await fs.writeFile(path.join(storage, oid), data);
      await fixture.git('reset', '--hard', 'HEAD^');
      await fs.writeFile(path.join(fixture.parent, '.netrc'), 'machine 127.0.0.1 login ambient password ambient-secret\n');
      await fixture.git('config', 'url.https://ungranted.invalid/.insteadOf', endpoint);
      let refPublished = false;
      let uploadDirectory;
      const credentialResolver = { resolve: vi.fn(async ({ endpoint: allowedEndpoint, credentialId }) => ({
        mode: 'managed', transport: 'https', username: 'oauth2', password: credentialId === 'lfs-only' ? 'lfs-fixture-secret' : 'parent-fixture-secret', allowedEndpoint,
      })) };
      const service = createNetworkOperations({
        credentialResolver, credentialBroker: broker,
        validateGitTransportContext: async () => ({ endpoint: ENDPOINT, endpointFingerprint: fingerprintRemoteUrl(ENDPOINT),
          transportMode: 'managed', credentialId: 'parent', transportRevision: 'transport_one' }),
        validateGitAuxiliaryContext: async ({ rawEndpoint }) => {
          expect(rawEndpoint).toBe(endpoint);
          return { endpoint, endpointFingerprint: fingerprintRemoteUrl(endpoint), transportMode: 'managed', credentialId: 'lfs-only', transportRevision: 'transport_one' };
        },
        systemPushAcknowledgements: { isAcknowledged: async () => true, acknowledge: async () => {} },
        runtimeIdentity: { id: 'fixture', platform: 'web' }, inheritedEnv: { ...fixture.env, LFS_DEBUG_HTTP: '1', GIT_LFS_SKIP_PUSH: '1' },
        timeoutMs: 15_000,
        spawnImpl: (binary, args, options) => {
          if (args.includes('push') && !args.includes('lfs')) {
            expect(uploaded).toEqual([data]);
            refPublished = true;
            return createSpawn().spawnImpl(binary, args, options);
          }
          if (args.includes('--object-id')) {
            uploadDirectory = options.cwd;
            expect(options.env.LFS_DEBUG_HTTP).toBeUndefined();
            expect(options.env.GIT_LFS_SKIP_PUSH).toBeUndefined();
            // Only this disposable TLS fixture overrides certificate validation.
            const index = args.indexOf('lfs');
            return spawn(binary, [...args.slice(0, index), '-c', 'http.sslVerify=false', '-c', `http.${endpoint}.sslVerify=false`, ...args.slice(index)], options);
          }
          return spawn(binary, args, options);
        },
      });
      const plan = await service.plan(request('push', { directory: fixture.directory }));
      const result = await service.execute(plan.operationId);
      expect(result, JSON.stringify(result)).toMatchObject({ state: 'succeeded' });
      expect(refPublished).toBe(true);
      expect(requests.map((request) => request.path)).toEqual(['/storage/objects/batch', `/storage/upload/${oid}`]);
      expect(requests.every((request) => request.authorization === `Basic ${Buffer.from('oauth2:lfs-fixture-secret').toString('base64')}`)).toBe(true);
      expect(broker.snapshot().activeOperations).toBe(0);
      expect(credentialResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 'lfs-only',
        endpoint: { protocol: 'https', host: '127.0.0.1', port: server.address().port, path: 'storage' } }));
      await expect(fs.stat(uploadDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await broker.close();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 30_000);

  it('ignores unrelated refs and working-tree LFS configuration when publishing a pinned source', async () => {
    const fixture = await createLfsPublicationFixture();
    const unrelated = 'e'.repeat(64);
    await fs.writeFile(path.join(fixture.directory, 'unrelated.bin'), `version https://git-lfs.github.com/spec/v1\noid sha256:${unrelated}\nsize 12\n`);
    await fs.writeFile(path.join(fixture.directory, '.lfsconfig'), '[lfs]\nurl = https://ungranted.invalid/storage\n');
    await fixture.git('add', '.');
    await fixture.git('commit', '-m', 'unrelated HEAD');
    const plan = await fixture.service.plan(fixture.pushRequest);
    expect((await fixture.service.execute(plan.operationId)).state).toBe('succeeded');
    const upload = fixture.calls.find((call) => call.args.includes('--object-id'));
    expect(upload.args.slice(upload.args.indexOf('lfs'))).toEqual(['lfs', 'push', '--object-id', 'openchamber-lfs', fixture.oid]);
    expect(upload.args).toContain(`lfs.pushurl=${fixture.lfsEndpoint}`);
    expect(upload.args).not.toContain(unrelated);
  });

  it.each(['missing', 'system', 'wrong-endpoint', 'wrong-credential', 'client-missing'])('blocks LFS and Git publication for %s', async (problem) => {
    const fixture = await createLfsPublicationFixture();
    if (problem === 'missing') fixture.validateGitAuxiliaryContext.mockRejectedValue(Object.assign(new Error('private endpoint details'), { code: 'GIT_AUXILIARY_AUTHORIZATION_REQUIRED' }));
    if (problem === 'system' || problem === 'wrong-endpoint') fixture.validateGitAuxiliaryContext.mockResolvedValue({
      endpoint: problem === 'wrong-endpoint' ? 'https://other.example/storage' : fixture.lfsEndpoint,
      endpointFingerprint: fingerprintRemoteUrl(fixture.lfsEndpoint), transportMode: problem === 'system' ? 'system' : 'managed', credentialId: 'lfs-only',
    });
    if (problem === 'wrong-credential') {
      const resolve = fixture.credentialResolver.resolve.getMockImplementation();
      fixture.credentialResolver.resolve.mockImplementation((input) => {
        if (input.credentialId === 'lfs-only') throw new Error('stored credential is unavailable');
        return resolve(input);
      });
    }
    if (problem === 'client-missing') Object.assign(fixture.binaryResult, { code: 1, stdout: '' });
    const plan = await fixture.service.plan(fixture.pushRequest);
    const result = await fixture.service.execute(plan.operationId);
    expect(result).toMatchObject({ state: 'failed', error: { code: problem === 'client-missing' ? 'GIT_LFS_CLIENT_MISSING' : 'AUTHENTICATION_REQUIRED' } });
    expect(result.error.message).toMatch(problem === 'client-missing' ? /Install git-lfs/ : /Grant.*stored credential/);
    expect(fixture.calls.some((call) => call.args.includes('push'))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/private endpoint|lfs-secret|parent-secret/);
    for (const call of fixture.calls.filter((call) => call.args.includes('init'))) {
      await expect(fs.stat(call.options.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.each(['grant', 'source', 'config'])('revalidates the %s after LFS credentials resolve', async (changed) => {
    const fixture = await createLfsPublicationFixture();
    const resolve = fixture.credentialResolver.resolve.getMockImplementation();
    fixture.credentialResolver.resolve.mockImplementation(async (input) => {
      if (input.credentialId === 'lfs-only') {
        if (changed === 'grant') fixture.validateGitAuxiliaryContext.mockResolvedValue({
          endpoint: fixture.lfsEndpoint, endpointFingerprint: fingerprintRemoteUrl(fixture.lfsEndpoint), transportMode: 'managed', credentialId: 'changed', transportRevision: 'changed',
        });
        else if (changed === 'config') await fixture.git('config', 'lfs.pushurl', 'https://changed.example/storage');
        else await fixture.git('update-ref', 'refs/heads/feature', 'HEAD');
      }
      return resolve(input);
    });
    const plan = await fixture.service.plan(fixture.pushRequest);
    expect(await fixture.service.execute(plan.operationId)).toMatchObject({ state: 'conflicted', error: { code: changed === 'grant' ? 'REMOTE_CHANGED' : 'STALE_CONFIG' } });
    expect(fixture.calls.some((call) => call.args.includes('push'))).toBe(false);
    expect(fixture.broker.revoke).toHaveBeenCalledWith(`${plan.operationId}:lfs-upload`);
  });

  it.each(['cancel', 'timeout'])('owns and cleans an LFS upload interrupted by %s without publishing refs', async (reason) => {
    const fixture = await createLfsPublicationFixture({ timeoutMs: reason === 'timeout' ? 2_000 : 10_000 });
    fixture.uploadResult.manual = true;
    const plan = await fixture.service.plan(fixture.pushRequest);
    const running = fixture.service.execute(plan.operationId);
    await vi.waitFor(() => expect(fixture.calls.some((call) => call.args.includes('--object-id'))).toBe(true));
    if (reason === 'cancel') fixture.service.cancel(plan.operationId);
    const result = await running;
    expect(result).toMatchObject({ state: 'cancelled', error: { code: reason === 'cancel' ? 'CANCELLED' : 'TIMEOUT' } });
    expect(result.completedSteps).not.toContain('transferred');
    expect(fixture.calls.filter((call) => call.args.includes('push'))).toHaveLength(1);
    expect(fixture.transfers.children.at(-1).kill).toHaveBeenCalled();
    const upload = fixture.calls.find((call) => call.args.includes('--object-id'));
    await expect(fs.stat(upload.options.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fixture.broker.revoke).toHaveBeenCalledWith(`${plan.operationId}:lfs-upload`);
    expect(fixture.broker.revoke).toHaveBeenCalledWith(plan.operationId);
    expect(fixture.auditStore.finish).toHaveBeenCalledWith(`git:${plan.operationId}:lfs-upload`, expect.objectContaining({ state: 'cancelled' }));
  });

  it('does not publish refs after upload failure or claim success after subsequent Git push failure', async () => {
    for (const uploadFails of [true, false]) {
      const fixture = await createLfsPublicationFixture();
      Object.assign(uploadFails ? fixture.uploadResult : fixture.refResult, { code: 1, stderr: uploadFails ? 'rejected lfs-secret' : 'rejected parent-secret' });
      const plan = await fixture.service.plan(fixture.pushRequest);
      const result = await fixture.service.execute(plan.operationId);
      expect(result.state).toBe('failed');
      expect(fixture.calls.filter((call) => call.args.includes('push'))).toHaveLength(uploadFails ? 1 : 2);
      if (!uploadFails) expect(result.error.message).toContain('LFS objects were uploaded');
      expect(JSON.stringify(result)).not.toMatch(/lfs-secret|parent-secret/);
    }
  });

  it.each(['cancel-after-upload', 'credential-cleanup', 'audit-completion'])('blocks ref publication on %s after LFS upload', async (failure) => {
    const fixture = await createLfsPublicationFixture();
    const plan = await fixture.service.plan(fixture.pushRequest);
    if (failure === 'cancel-after-upload') fixture.uploadResult.onSpawn = ({ child }) => {
      child.once('close', () => fixture.service.cancel(plan.operationId));
    };
    if (failure === 'credential-cleanup') fixture.broker.issue.mockImplementation(({ operationId }) => ({
      gitConfigArgs: [], revoke: () => { if (operationId.endsWith(':lfs-upload')) throw new Error('private cleanup failure'); },
    }));
    if (failure === 'audit-completion') fixture.auditStore.finish.mockImplementation(async (id) => {
      if (id.endsWith(':lfs-upload')) throw new Error('private audit failure');
    });
    const result = await fixture.service.execute(plan.operationId);
    expect(result).toMatchObject({ state: failure === 'cancel-after-upload' ? 'cancelled' : 'failed',
      error: { code: failure === 'cancel-after-upload' ? 'CANCELLED' : 'UNKNOWN' } });
    expect(fixture.calls.filter((call) => call.args.includes('push'))).toHaveLength(1);
    await expect(fs.stat(fixture.calls.find((call) => call.args.includes('--object-id')).options.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each(['missing-grant', 'missing-client', 'push-failure', 'success'])('preserves completed Sync integration with LFS publication outcome %s', async (outcome) => {
    const fixture = await createLfsPublicationFixture();
    await fixture.git('checkout', 'feature');
    await fixture.git('rm', 'asset.bin');
    await fixture.git('commit', '-m', 'remove pointer from tip but retain history');
    const source = await fixture.git('rev-parse', 'HEAD');
    await fixture.git('checkout', 'published');
    await fixture.git('update-ref', 'refs/remotes/upstream/main', source);
    if (outcome === 'missing-grant') fixture.validateGitAuxiliaryContext.mockRejectedValue(Object.assign(new Error('not granted'), { code: 'GIT_AUXILIARY_AUTHORIZATION_REQUIRED' }));
    if (outcome === 'missing-client') Object.assign(fixture.binaryResult, { code: 1, stdout: '' });
    if (outcome === 'push-failure') Object.assign(fixture.refResult, { code: 1 });
    const plan = await fixture.service.plan(syncRequest({ directory: fixture.directory }));
    const result = await fixture.service.execute(plan.operationId);
    expect(result.state).toBe(outcome === 'success' ? 'succeeded' : 'partial');
    expect(result.stepResults).toMatchObject([
      { step: 'fetch', status: 'succeeded' }, { step: 'pull', status: 'succeeded' },
      { step: 'push', status: outcome === 'success' ? 'succeeded' : 'failed' },
    ]);
    expect(await fixture.git('rev-parse', 'HEAD')).toBe(source);
    if (outcome === 'missing-client') expect(result.stepResults[2].error.code).toBe('GIT_LFS_CLIENT_MISSING');
    if (outcome === 'missing-grant') expect(result.error.code).toBe('AUTHENTICATION_REQUIRED');
    if (outcome.startsWith('missing')) expect(fixture.calls.some((call) => call.args.includes('push'))).toBe(false);
    else expect(fixture.calls.findLast((call) => call.args.includes('push')).args).toContain(`${source}:refs/heads/published`);
  });

  const remoteFetchRequest = () => {
    const input = request('fetch');
    delete input.sourceRef;
    delete input.destinationRef;
    return { ...input, fetchScope: 'remote' };
  };

  it.each(['managed', 'system', 'anonymous'])('remote Fetch resolves configured heads on the selected remote using %s transport', async (mode) => {
    const auditStore = {
      plan: vi.fn(async (record) => ({ status: 'planned', record: { ...record, state: 'planned' } })),
      start: vi.fn(async () => ({})), finish: vi.fn(async () => ({})),
    };
    const operation = setup({ mode, auditStore, spawnResponder: ({ args }) => args[0] === 'config'
      ? { code: 0, stdout: '+refs/heads/*:refs/remotes/publish/*\0' } : { code: 0 } });
    expect(operation.calls).toHaveLength(0);
    const planned = await operation.service.plan({ ...remoteFetchRequest(), transportMode: mode });
    expect(operation.calls.every((call) => call.args[0] === 'config')).toBe(true);
    expect(operation.credentialResolver.resolve).not.toHaveBeenCalled();
    const [result, duplicate] = await Promise.all([
      operation.service.execute(planned.operationId), operation.service.execute(planned.operationId),
    ]);
    expect(result.state).toBe('succeeded');
    expect(duplicate).toEqual(result);
    const transfers = operation.calls.filter((call) => call.args.includes('fetch'));
    expect(transfers).toHaveLength(1);
    expect(transfers[0].args.slice(transfers[0].args.indexOf('fetch'))).toEqual([
      'fetch', '--atomic', '--no-tags', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', '--refmap=',
      '--', ENDPOINT, '+refs/heads/*:refs/remotes/publish/*',
    ]);
    expect(operation.resolveRef).not.toHaveBeenCalled();
    expect(operation.resolveSymbolicRef).not.toHaveBeenCalled();
    expect(auditStore.plan.mock.calls[0][0].target).toEqual({
      kind: 'git-network', operation: 'fetch', fetchScope: 'remote', force: true,
      remotes: [{ role: 'operation', name: 'publish', endpointFingerprint: fingerprintRemoteUrl(ENDPOINT) }],
    });
    expect(JSON.stringify(auditStore.plan.mock.calls)).not.toContain(ENDPOINT);
  });

  it.each([1, 2])('remote Fetch rejects mapping drift at execution validation %s before transfer', async (changeAt) => {
    let reads = 0;
    const operation = setup({ mode: 'system', spawnResponder: () => ({ code: 0, stdout: reads++ >= changeAt
      ? 'refs/heads/*:refs/remotes/publish/*\0' : '+refs/heads/*:refs/remotes/publish/*\0' }) });
    const planned = await operation.service.plan({ ...remoteFetchRequest(), transportMode: 'system' });
    const result = await operation.service.execute(planned.operationId);
    expect(result).toMatchObject({ state: 'conflicted', error: { code: 'STALE_CONFIG' } });
    expect(operation.calls.every((call) => call.args[0] === 'config')).toBe(true);
    expect(operation.credentialResolver.resolve).not.toHaveBeenCalled();
  });

  it.each([
    { code: 1 }, { code: 128, stderr: 'private config contents' },
    { code: 0, stdout: '+refs/*:refs/*\0' },
    { code: 0, stdout: 'x'.repeat(8193) },
  ])('remote Fetch rejects unavailable or unsupported configuration without a transfer', async (response) => {
    const operation = setup({ spawnResponder: () => response });
    await expect(operation.service.plan(remoteFetchRequest())).rejects.toBeInstanceOf(Error);
    expect(operation.calls).toHaveLength(1);
    expect(operation.credentialResolver.resolve).not.toHaveBeenCalled();
  });

  it('remote Fetch cancellation before execute starts no transfer', async () => {
    const operation = setup({ spawnResponder: () => ({ code: 0, stdout: '+refs/heads/*:refs/remotes/publish/*\0' }) });
    const planned = await operation.service.plan(remoteFetchRequest());
    expect((await operation.service.cancel(planned.operationId)).state).toBe('cancelled');
    await expect(operation.service.execute(planned.operationId)).rejects.toThrow('Git network operation cannot start');
    expect(operation.calls).toHaveLength(1);
    expect(operation.credentialResolver.resolve).not.toHaveBeenCalled();
  });

  const contributorSource = (overrides = {}) => ({
    context: {
      repositoryId: 'repo_one', bindingRevision: 2, accountId: 'account_one',
      instance: 'github.com', primaryRemote: 'origin', provider: 'github', directory: '/repository',
    },
    targetProject: { id: 'acme/app', owner: 'acme', name: 'app' },
    sourceProject: { id: 'alice/app', owner: 'alice', name: 'app' },
    number: 42, headRef: 'refs/heads/feature', headSha: SHA,
    requestedRemoteName: 'pr-alice', endpoint: ENDPOINT, classification: 'contributor-fork',
    ...overrides,
  });
  const contributorRequest = {
    context: {
      repositoryId: 'repo_one', bindingRevision: 2, accountId: 'account_one',
      instance: 'github.com', primaryRemote: 'origin', provider: 'github', directory: '/repository',
    },
    project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 42,
    expectedHeadSha: SHA, requestedRemoteName: 'pr-alice',
  };

  it('uses one audit identity for duplicate execute calls and records the compact result', async () => {
    const auditStore = {
      plan: vi.fn(async (record) => ({ status: 'planned', record: { ...record, state: 'planned' } })),
      start: vi.fn(async () => ({})),
      finish: vi.fn(async () => ({})),
    };
    const credentialId = createHttpsCredentialReference({
      provider: 'gitlab', instance: 'https://example.com', credentialId: 'credential-one',
      credentialRevision: 4, providerUserId: 'https://example.com#42',
    });
    const operation = setup({ auditStore, credentialId });
    const planned = await operation.service.plan(request());
    const [first, duplicate] = await Promise.all([
      operation.service.execute(planned.operationId),
      operation.service.execute(planned.operationId),
    ]);

    expect(first.state).toBe('succeeded');
    expect(duplicate).toEqual(first);
    expect(operation.calls.filter((call) => call.args.includes('push'))).toHaveLength(1);
    expect(auditStore.plan).toHaveBeenCalledOnce();
    expect(auditStore.plan).toHaveBeenCalledWith(expect.objectContaining({
      id: 'git:git_operation_one', initiator: 'user', executorKind: 'openchamber-server-git',
      repositoryId: 'repo_one', providerAccountId: 'https://example.com#42',
      transportReference: { kind: 'managed', credentialId },
    }));
    expect(auditStore.finish).toHaveBeenCalledOnce();
    expect(auditStore.finish).toHaveBeenLastCalledWith('git:git_operation_one', {
      state: 'succeeded', errorCode: null, steps: ['validated', 'authenticated', 'transferred'],
    });
  });

  it('preserves separate system and managed sync transport references', async () => {
    const auditStore = {
      plan: vi.fn(async (record) => ({ status: 'planned', record: { ...record, state: 'planned' } })),
      start: vi.fn(async () => ({})),
      finish: vi.fn(async () => ({})),
    };
    const credentialId = createHttpsCredentialReference({
      provider: 'github', instance: 'github.com', credentialId: 'github-credential',
      credentialRevision: 2, providerUserId: 'github.com#42',
    });
    const operation = setup({
      auditStore,
      credentialId,
      authorityFor: (input, authority) => input.endpointKind === 'fetch'
        ? { ...authority, transportMode: 'system', credentialId: undefined }
        : { ...authority, credentialId },
    });
    const input = syncRequest();
    input.fetch.transportMode = 'system';
    await operation.service.plan(input);

    expect(auditStore.plan).toHaveBeenCalledWith(expect.objectContaining({
      providerAccountId: 'github.com#42',
      transportReference: {
        kind: 'sync',
        fetch: { kind: 'system', marker: 'system-credentials' },
        push: { kind: 'managed', credentialId },
      },
    }));
  });

  it('audits contributor fetch with its exact credential and provider-user identity', async () => {
    const auditStore = {
      plan: vi.fn(async (record) => ({ status: 'planned', record: { ...record, state: 'planned' } })),
      start: vi.fn(async () => ({})),
      finish: vi.fn(async () => ({})),
    };
    const credentialId = createHttpsCredentialReference({
      provider: 'github', instance: 'github.com', credentialId: 'account_one',
      credentialRevision: 2, providerUserId: 'github.com#42',
    });
    const operation = setup({ auditStore, credentialId, resolveChangeRequestSource: vi.fn(async () => contributorSource()) });
    await operation.service.transferContributorHead({
      directory: '/repository', sourceRequest: contributorRequest, source: contributorSource(),
      credentialId, destinationRef: 'refs/remotes/pr-alice/feature',
    });

    expect(auditStore.plan).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: 'repo_one',
      providerAccountId: 'github.com#42',
      transportReference: { kind: 'managed', credentialId },
      target: expect.objectContaining({ operation: 'contributor-fetch' }),
    }));
  });

  it('does not expose a credential ID as provider identity for an older v2 reference without attribution', async () => {
    const auditStore = {
      plan: vi.fn(async (record) => ({ status: 'planned', record: { ...record, state: 'planned' } })),
      start: vi.fn(async () => ({})),
      finish: vi.fn(async () => ({})),
    };
    const attributed = createHttpsCredentialReference({
      provider: 'github', instance: 'github.com', credentialId: 'opaque-credential',
      credentialRevision: 2, providerUserId: 'github.com#42',
    });
    const credentialId = attributed.split(':').slice(0, -1).join(':');

    await setup({ auditStore, credentialId }).service.plan(request());

    expect(auditStore.plan).toHaveBeenCalledWith(expect.objectContaining({
      providerAccountId: null,
      transportReference: { kind: 'managed', credentialId },
    }));
  });

  it('rolls back registration when audit planning fails and does not touch audit on duplicate registration', async () => {
    const auditFailure = Object.assign(new Error('audit unavailable'), { code: 'AUDIT_UNAVAILABLE' });
    const failedAudit = {
      plan: vi.fn(async () => { throw auditFailure; }),
      start: vi.fn(),
      finish: vi.fn(),
    };
    const failed = setup({ auditStore: failedAudit });
    await expect(failed.service.plan(request())).rejects.toBe(auditFailure);
    expect(failed.service.get('git_operation_one')).toMatchObject({ state: 'cancelled' });
    expect(failedAudit.start).not.toHaveBeenCalled();

    const auditStore = {
      plan: vi.fn(async (record) => ({ status: 'planned', record: { ...record, state: 'planned' } })),
      start: vi.fn(),
      finish: vi.fn(),
    };
    const duplicate = setup({ auditStore });
    await duplicate.service.plan(request());
    await expect(duplicate.service.plan(request())).rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_EXISTS' });
    expect(auditStore.plan).toHaveBeenCalledOnce();
    expect(duplicate.service.get('git_operation_one')).toMatchObject({ state: 'planned' });
  });

  it('re-resolves contributor authority and strips ambient credentials before managed fetch', async () => {
    const resolveChangeRequestSource = vi.fn(async () => contributorSource());
    const setupValue = setup({
      resolveChangeRequestSource,
      env: { GIT_ASKPASS: '/ambient/askpass', SSH_AUTH_SOCK: '/ambient/agent', HOME: '/ambient/home' },
    });
    const result = await setupValue.service.transferContributorHead({
      directory: '/repository', sourceRequest: contributorRequest, source: contributorSource(),
      credentialId: 'opaque-credential', destinationRef: 'refs/remotes/pr-alice/feature',
    });

    expect(result.state).toBe('succeeded');
    expect(resolveChangeRequestSource).toHaveBeenCalledTimes(3);
    expect(setupValue.calls).toHaveLength(1);
    const fetchCall = setupValue.calls[0];
    expect(fetchCall.args).toEqual(expect.arrayContaining([
      'fetch', '--no-tags', '--', ENDPOINT, 'refs/heads/feature:refs/remotes/pr-alice/feature',
    ]));
    expect(fetchCall.options.env.GIT_ASKPASS).toBeUndefined();
    expect(fetchCall.options.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(fetchCall.options.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(fetchCall.options.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('rejects a changed contributor endpoint before transfer', async () => {
    const resolveChangeRequestSource = vi.fn(async () => contributorSource({ endpoint: 'https://example.com/attacker/repository.git' }));
    const setupValue = setup({ resolveChangeRequestSource });
    const result = await setupValue.service.transferContributorHead({
      directory: '/repository', sourceRequest: contributorRequest, source: contributorSource(),
      credentialId: 'opaque-credential', destinationRef: 'refs/remotes/pr-alice/feature',
    });

    expect(result).toMatchObject({ state: 'conflicted', error: { code: 'STALE_CONFIG' } });
    expect(setupValue.calls).toHaveLength(0);
  });

  it('distinguishes malformed provider data from unavailable contributor authorization', async () => {
    const malformed = setup({
      resolveChangeRequestSource: vi.fn(async () => {
        throw Object.assign(new Error('bad provider payload'), { code: 'MALFORMED_PROVIDER_RESPONSE' });
      }),
    });
    const malformedResult = await malformed.service.transferContributorHead({
      directory: '/repository', sourceRequest: contributorRequest, source: contributorSource(),
      credentialId: 'opaque-credential', destinationRef: 'refs/remotes/pr-alice/feature',
    });
    expect(malformedResult).toMatchObject({ state: 'failed', error: { code: 'UNKNOWN' } });
    expect(malformed.calls).toHaveLength(0);

    const unavailable = setup({
      resolveChangeRequestSource: vi.fn(async () => {
        throw Object.assign(new Error('not found'), { status: 404 });
      }),
    });
    const unavailableResult = await unavailable.service.transferContributorHead({
      directory: '/repository', sourceRequest: contributorRequest, source: contributorSource(),
      credentialId: 'opaque-credential', destinationRef: 'refs/remotes/pr-alice/feature',
    });
    expect(unavailableResult).toMatchObject({
      state: 'failed', error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(unavailable.calls).toHaveLength(0);
  });

  it('runs checkout actions only for an unchanged explicit trust decision', async () => {
    const setupValue = setup();
    const inspect = vi.fn(async () => ({
      digest: 'digest_one',
      actions: [{ kind: 'setup-command', command: 'bun install' }],
    }));
    const result = await setupValue.service.decideCheckoutTrust({
      directory: '/repository', repositoryId: 'repo_one', digest: 'digest_one', decision: 'run', inspect,
      headSha: SHA, nullRef: '0'.repeat(40),
    });

    expect(result.state).toBe('succeeded');
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(setupValue.calls).toHaveLength(1);
    expect(setupValue.calls[0].args).toEqual(['-c', 'bun install']);
  });

  it('executes checkout actions with audit enabled and records one compact result', async () => {
    const auditStore = {
      plan: vi.fn(async (record) => ({ status: 'planned', record: { ...record, state: 'planned' } })),
      start: vi.fn(async () => ({})),
      finish: vi.fn(async () => ({})),
    };
    const operation = setup({ auditStore });
    const inspect = vi.fn(async () => ({
      digest: 'digest_one', actions: [{ kind: 'setup-command', command: 'bun install' }],
    }));
    const result = await operation.service.decideCheckoutTrust({
      directory: '/repository', repositoryId: 'repo_one', digest: 'digest_one', decision: 'run', inspect,
      headSha: SHA, nullRef: '0'.repeat(40),
    });

    expect(result.state).toBe('succeeded');
    expect(operation.calls).toHaveLength(1);
    expect(auditStore.plan).toHaveBeenCalledOnce();
    expect(auditStore.plan).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: 'repo_one',
      transportReference: { kind: 'system', marker: 'local-checkout-actions' },
      target: { kind: 'git-network', operation: 'checkout-actions', remotes: [] },
    }));
    expect(auditStore.start).toHaveBeenCalledOnce();
    expect(auditStore.finish).toHaveBeenCalledOnce();
    expect(auditStore.finish).toHaveBeenCalledWith(expect.stringMatching(/^git:/), {
      state: 'succeeded', errorCode: null, steps: ['validated'],
    });
  });

  it('executes a verified operation-owned hook snapshot and cleans it after a repository replacement', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-hook-race-'));
    temporaryDirectories.push(parent);
    const mutableHook = path.join(parent, 'post-checkout');
    const approved = Buffer.from('#!/bin/sh\nexit 0\n');
    await fs.writeFile(mutableHook, approved, { mode: 0o700 });
    let snapshotPath = '';
    const setupValue = setup({
      env: { HOME: '/home/test' },
      spawnResponder: ({ file, options }) => ({
        code: 0,
        onSpawn: async () => {
          snapshotPath = file;
          expect(file).not.toBe(mutableHook);
          expect(await fs.readFile(file)).toEqual(approved);
          expect(options.env).toMatchObject({ GIT_DIR: '/repository/.git', GIT_WORK_TREE: '/repository' });
        },
      }),
    });
    const action = {
      kind: 'post-checkout-hook', path: mutableHook, content: approved,
      contentDigest: crypto.createHash('sha256').update(approved).digest('base64url'),
      gitDir: '/repository/.git', workTree: '/repository',
    };
    const inspect = vi.fn(async () => {
      if (inspect.mock.calls.length === 2) await fs.writeFile(mutableHook, '#!/bin/sh\nexit 99\n');
      return { digest: 'digest_one', actions: [action] };
    });

    const result = await setupValue.service.decideCheckoutTrust({
      directory: '/repository', repositoryId: 'repo_one', digest: 'digest_one', decision: 'run', inspect,
      headSha: SHA, nullRef: '0'.repeat(40),
    });

    expect(result.state).toBe('succeeded');
    expect(snapshotPath).not.toBe('');
    await expect(fs.stat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans a hook snapshot after timeout cancellation', async () => {
    const approved = Buffer.from('#!/bin/sh\nexit 0\n');
    let snapshotPath = '';
    const setupValue = setup({
      timeoutMs: 100,
      spawnResponder: ({ file }) => {
        snapshotPath = file;
        return { manual: true };
      },
    });
    const inspect = vi.fn(async () => ({
      digest: 'digest_one',
      actions: [{
        kind: 'post-checkout-hook', path: '/repository/.git/hooks/post-checkout', content: approved,
        contentDigest: crypto.createHash('sha256').update(approved).digest('base64url'),
        gitDir: '/repository/.git', workTree: '/repository',
      }],
    }));

    const result = await setupValue.service.decideCheckoutTrust({
      directory: '/repository', repositoryId: 'repo_one', digest: 'digest_one', decision: 'run', inspect,
      headSha: SHA, nullRef: '0'.repeat(40),
    });

    expect(result.state).toBe('cancelled');
    expect(snapshotPath).not.toBe('');
    await expect(fs.stat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects changed checkout actions before execution and skips without execution', async () => {
    const changed = setup();
    const inspectChanged = vi.fn()
      .mockResolvedValueOnce({ digest: 'digest_one', actions: [] })
      .mockResolvedValueOnce({ digest: 'digest_two', actions: [] });
    const changedResult = await changed.service.decideCheckoutTrust({
      directory: '/repository', repositoryId: 'repo_one', digest: 'digest_one', decision: 'run', inspect: inspectChanged,
      headSha: SHA, nullRef: '0'.repeat(40),
    });
    expect(changedResult).toMatchObject({ state: 'conflicted', error: { code: 'STALE_CONFIG' } });
    expect(changed.calls).toHaveLength(0);

    const skipped = setup();
    const skippedResult = await skipped.service.decideCheckoutTrust({
      directory: '/repository', repositoryId: 'repo_one', digest: 'digest_one', decision: 'skip',
      inspect: vi.fn(async () => ({ digest: 'digest_one', actions: [] })),
      headSha: SHA, nullRef: '0'.repeat(40),
    });
    expect(skippedResult).toEqual({ state: 'skipped', digest: 'digest_one' });
    expect(skipped.calls).toHaveLength(0);
  });

  it('does not invoke ambient helpers or AskPass after a managed broker mismatch', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-ambient-auth-'));
    temporaryDirectories.push(parent);
    const helperMarker = path.join(parent, 'helper-marker');
    const askPassMarker = path.join(parent, 'askpass-marker');
    const helper = path.join(parent, 'ambient-helper.mjs');
    const askPass = path.join(parent, 'ambient-askpass.mjs');
    const fakeGit = path.join(parent, 'fake-git.mjs');
    const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
    await fs.writeFile(helper, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(helperMarker)}, 'used');\n`);
    await fs.writeFile(askPass, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(askPassMarker)}, 'used'); process.stdout.write('ambient');\n`);
    await fs.writeFile(fakeGit, `#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process';\nconst input = 'protocol=https\\nhost=example.com\\npath=wrong/repository.git\\n\\n';\nconst split = process.argv.indexOf('push');\nconst result = spawnSync('git', [...process.argv.slice(2, split), 'credential', 'fill'], { env: process.env, input, stdio: ['pipe', 'pipe', 'pipe'] });\nprocess.stderr.write(result.stderr || '');\nprocess.exit(Number.isInteger(result.status) ? result.status : 1);\n`);
    await fs.chmod(fakeGit, 0o700);
    await fs.writeFile(path.join(parent, '.gitconfig'), [
      '[credential]',
      `\thelper = !${quote(process.execPath)} ${quote(helper)}`,
      '[credential "https://example.com"]',
      `\thelper = !${quote(process.execPath)} ${quote(helper)}`,
      '[core]',
      `\taskPass = ${askPass}`,
      '',
    ].join('\n'));
    const credentialBroker = (await import('./credential-broker.js')).createGitCredentialBroker();
    const authority = {
      endpoint: ENDPOINT,
      endpointFingerprint: fingerprintRemoteUrl(ENDPOINT),
      transportMode: 'managed',
      credentialId: 'opaque-credential',
      transportRevision: 'transport_one',
    };
    const service = createNetworkOperations({
      validateGitTransportContext: async () => authority,
      systemPushAcknowledgements: {
        isAcknowledged: async () => true,
        acknowledge: async () => {},
      },
      resolveRef: async () => SHA,
      resolveSymbolicRef: async () => 'refs/heads/published',
      credentialResolver: {
        resolve: async () => ({
          mode: 'managed',
          transport: 'https',
          username: 'oauth2',
          password: 'managed-secret',
          allowedEndpoint: { protocol: 'https', host: 'example.com', port: 443, path: 'owner/repository.git' },
        }),
      },
      credentialBroker,
      runtimeIdentity: { id: 'runtime_one', platform: 'web' },
      idFactory: () => 'git_ambient_test',
      gitBinary: fakeGit,
      inheritedEnv: { ...process.env, HOME: parent, GIT_ASKPASS: askPass, SSH_ASKPASS: askPass },
      timeoutMs: 10_000,
      enumerateManagedConfigKeys: async () => [],
    });
    const plan = await service.plan(request());
    await expect(service.execute(plan.operationId)).resolves.toMatchObject({ state: 'failed' });
    await credentialBroker.close();
    await expect(fs.stat(helperMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(askPassMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sends only broker authentication to managed HTTPS endpoints', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-http-auth-'));
    temporaryDirectories.push(parent);
    const keyPath = path.join(parent, 'server.key');
    const certificatePath = path.join(parent, 'server.crt');
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-keyout', keyPath, '-out', certificatePath,
    ]);
    const requests = [];
    const redirectedRequests = [];
    const proxyRequests = [];
    const expectedAuthorization = `Basic ${Buffer.from('oauth2:managed-secret').toString('base64')}`;
    const redirectedServer = https.createServer({
      key: await fs.readFile(keyPath),
      cert: await fs.readFile(certificatePath),
    }, (incoming, response) => {
      redirectedRequests.push(incoming.headers);
      response.writeHead(403).end();
    });
    await new Promise((resolve, reject) => {
      redirectedServer.once('error', reject);
      redirectedServer.listen(0, '127.0.0.1', resolve);
    });
    const proxyServer = http.createServer((incoming, response) => {
      proxyRequests.push(incoming.headers);
      response.writeHead(502).end();
    });
    proxyServer.on('connect', (incoming, socket) => {
      proxyRequests.push(incoming.headers);
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    await new Promise((resolve, reject) => {
      proxyServer.once('error', reject);
      proxyServer.listen(0, '127.0.0.1', resolve);
    });
    const server = https.createServer({
      key: await fs.readFile(keyPath),
      cert: await fs.readFile(certificatePath),
    }, (incoming, response) => {
      requests.push(incoming.headers);
      if (incoming.headers.authorization === expectedAuthorization) {
        response.writeHead(302, {
          location: `https://127.0.0.1:${redirectedServer.address().port}/redirected.git`,
        }).end();
      } else {
        response.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end();
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const endpoint = `https://127.0.0.1:${server.address().port}/owner/repository.git`;
    const cookiePath = path.join(parent, 'cookies.txt');
    const configPath = path.join(parent, '.gitconfig');
    await fs.writeFile(cookiePath, '127.0.0.1\tFALSE\t/\tTRUE\t2147483647\tambient-cookie\tsecret\n');
    await fs.writeFile(configPath, [
      '[http]',
      '\textraHeader = Authorization: Bearer ambient-global',
      '\textraHeader = PRIVATE-TOKEN: ambient-global-private',
      `\tcookieFile = ${cookiePath}`,
      '\tsaveCookies = true',
      '\tsslVerify = false',
      `[http "${endpoint}"]`,
      `\tproxy = http://127.0.0.1:${proxyServer.address().port}`,
      '\textraHeader = Authorization: Bearer ambient-scoped',
      '\textraHeader = PRIVATE-TOKEN: ambient-scoped-private',
      `\tcookieFile = ${cookiePath}`,
      '\tsaveCookies = true',
      '',
    ].join('\n'));
    const gitBinary = (await execFileAsync('which', ['git'])).stdout.trim();
    const fixtureGit = path.join(parent, 'fixture-git.mjs');
    await fs.writeFile(fixtureGit, `#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process';\nconst args = process.argv.slice(2);\nconst operation = args.findIndex((value) => value === 'fetch' || value === 'push' || value === 'clone');\nconst endpoint = args.find((value) => value.startsWith('https://'));\nargs.splice(operation, 0, '-c', 'http.sslVerify=false', '-c', \`http.\${endpoint}.sslVerify=false\`);\nconst result = spawnSync(${JSON.stringify(gitBinary)}, args, { env: process.env, stdio: 'inherit' });\nprocess.exit(Number.isInteger(result.status) ? result.status : 1);\n`);
    await fs.chmod(fixtureGit, 0o700);
    const repository = path.join(parent, 'repository');
    await execFileAsync(gitBinary, ['init', repository]);
    const credentialBroker = (await import('./credential-broker.js')).createGitCredentialBroker();
    const authority = {
      endpoint,
      endpointFingerprint: `fp_${fingerprintRemoteUrl(endpoint)}`,
      transportMode: 'managed',
      credentialId: 'opaque-credential',
      transportRevision: 'transport_one',
    };
    const service = createNetworkOperations({
      validateGitTransportContext: async () => authority,
      systemPushAcknowledgements: {
        isAcknowledged: async () => true,
        acknowledge: async () => {},
      },
      resolveRef: async () => SHA,
      resolveSymbolicRef: async () => 'refs/heads/published',
      credentialResolver: {
        resolve: async () => ({
          mode: 'managed', transport: 'https', username: 'oauth2', password: 'managed-secret',
          actor: { provider: 'gitlab', instance: `https://127.0.0.1:${server.address().port}`, accountId: 'account-one', login: null },
          allowedEndpoint: { protocol: 'https', host: '127.0.0.1', port: server.address().port, path: 'owner/repository.git' },
        }),
      },
      credentialBroker,
      runtimeIdentity: { id: 'runtime_one', platform: 'web' },
      idFactory: () => 'git_http_auth_test',
      gitBinary: fixtureGit,
      inheritedEnv: {
        ...process.env,
        HOME: parent,
        GIT_CONFIG_GLOBAL: configPath,
        HTTPS_PROXY: `http://127.0.0.1:${proxyServer.address().port}`,
        https_proxy: `http://127.0.0.1:${proxyServer.address().port}`,
        GIT_TRACE_CURL: path.join(parent, 'git-curl.trace'),
      },
      timeoutMs: 10_000,
      enumerateManagedConfigKeys: async () => [],
    });
    try {
      const plan = await service.plan(request('fetch', {
        directory: repository,
        remote: { name: 'publish', endpoint: { displayUrl: endpoint, fingerprint: authority.endpointFingerprint } },
      }));
      const result = await service.execute(plan.operationId);
      expect(result).toMatchObject({ state: 'failed' });
      expect(requests.map((headers) => headers.authorization), JSON.stringify(result)).toContain(expectedAuthorization);
      for (const headers of requests) {
        expect(String(headers.authorization ?? '')).not.toContain('ambient');
        expect(headers['private-token']).toBeUndefined();
        expect(headers.cookie).toBeUndefined();
      }
      expect(redirectedRequests).toEqual([]);
      expect(proxyRequests).toEqual([]);
      await expect(fs.stat(path.join(parent, 'git-curl.trace'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await credentialBroker.close();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => redirectedServer.close(resolve));
      await new Promise((resolve) => proxyServer.close(resolve));
    }
  });

  it('resets longer local include URL sections before managed HTTPS transfer', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-http-config-'));
    temporaryDirectories.push(parent);
    const repository = path.join(parent, 'repository');
    const includedConfig = path.join(parent, 'included.gitconfig');
    const fakeGit = path.join(parent, 'fake-git.mjs');
    const gitBinary = (await execFileAsync('which', ['git'])).stdout.trim();
    await execFileAsync(gitBinary, ['init', repository]);
    await fs.writeFile(includedConfig, [
      `[http "${ENDPOINT}/info"]`,
      '\textraHeader = Authorization: Bearer ambient',
      '\tproxy = http://proxy.invalid',
      '\tsslVerify = false',
      '\tsslCAInfo = /private/ambient-ca.pem',
      '',
    ].join('\n'));
    await execFileAsync(gitBinary, ['config', '--local', 'include.path', includedConfig], { cwd: repository });
    await fs.writeFile(fakeGit, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('rev-list')) process.exit(0);
const operation = args.findIndex((value) => value === 'push');
if (operation < 0) {
  const result = spawnSync(${JSON.stringify(gitBinary)}, args, { env: process.env, stdio: 'inherit' });
  process.exit(Number.isInteger(result.status) ? result.status : 1);
}
const prefix = args.slice(0, operation);
const url = '${ENDPOINT}/info/refs';
const read = (key) => spawnSync(${JSON.stringify(gitBinary)}, [...prefix, 'config', '--get-urlmatch', key, url], { env: process.env, encoding: 'utf8' }).stdout.trim();
const safe = read('http.extraHeader') === ''
  && read('http.proxy') === ''
  && read('http.sslVerify') === 'true'
  && read('http.sslCAInfo') === '';
process.exit(safe ? 0 : 1);
`);
    await fs.chmod(fakeGit, 0o700);
    const credentialBroker = {
      start: vi.fn(async () => {}),
      issue: vi.fn(() => ({ gitConfigArgs: ['-c', 'credential.helper=!broker nonce'], revoke: vi.fn() })),
      revoke: vi.fn(),
    };
    const authority = {
      endpoint: ENDPOINT,
      endpointFingerprint: fingerprintRemoteUrl(ENDPOINT),
      transportMode: 'managed',
      credentialId: 'opaque-credential',
      transportRevision: 'transport_one',
    };
    const service = createNetworkOperations({
      validateGitTransportContext: vi.fn(async () => authority),
      systemPushAcknowledgements: { isAcknowledged: async () => true, acknowledge: async () => {} },
      resolveRef: async () => SHA,
      resolveSymbolicRef: async () => 'refs/heads/published',
      credentialResolver: { resolve: async () => ({
        mode: 'managed', transport: 'https', username: 'oauth2', password: 'managed-secret',
        allowedEndpoint: { protocol: 'https', host: 'example.com', port: 443, path: 'owner/repository.git' },
      }) },
      credentialBroker,
      runtimeIdentity: { id: 'runtime_one', platform: 'web' },
      idFactory: () => 'git_config_test',
      gitBinary: fakeGit,
      inheritedEnv: { ...process.env, HOME: parent },
      timeoutMs: 10_000,
    });
    const plan = await service.plan(request('push', { directory: repository }));

    await expect(service.execute(plan.operationId)).resolves.toMatchObject({ state: 'succeeded' });
    expect(credentialBroker.issue).toHaveBeenCalledOnce();
  });

  it('uses only the exact endpoint and refspec for managed push and clears ambient transport configuration', async () => {
    const env = {
      PATH: '/bin', GIT_ASKPASS: 'ambient', SSH_ASKPASS: 'ambient', SSH_ASKPASS_REQUIRE: 'force',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'store',
      GIT_CONFIG_PARAMETERS: 'unsafe', GIT_SSH: 'wrapper', GIT_SSH_COMMAND: 'wrapper', GIT_PROXY_COMMAND: 'proxy',
      HTTP_PROXY: 'http://proxy.invalid', https_proxy: 'http://proxy.invalid', NO_PROXY: 'example.com',
      GIT_TRACE: '/tmp/git-trace', GIT_TRACE_CURL: '/tmp/git-curl-trace', GIT_REDIRECT_STDERR: '/tmp/git-stderr',
      CURL_CA_BUNDLE: '/tmp/ca.pem', SSL_CERT_FILE: '/tmp/cert.pem', GIT_SSL_NO_VERIFY: '1',
    };
    const setupValue = setup({ env });
    const plan = await setupValue.service.plan(request());
    const result = await setupValue.service.execute(plan.operationId);

    expect(result.state).toBe('succeeded');
    expect(setupValue.calls).toHaveLength(2);
    const call = setupValue.calls.find((entry) => entry.args.includes('push'));
    expect(call.args).toEqual([
      '-c', 'core.askPass=', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'core.hooksPath=/dev/null',
      '-c', 'http.proxy=', '-c', 'http.sslVerify=true',
      '-c', 'http.extraHeader=', '-c', 'http.cookieFile=',
      '-c', 'http.saveCookies=false', '-c', 'http.emptyAuth=false', '-c', 'http.delegation=none',
      '-c', 'http.sslAutoClientCert=false', '-c', 'credential.username=', '-c', 'credential.interactive=false',
      '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false',
      '-c', `http.${ENDPOINT}.proxy=`, '-c', `http.${ENDPOINT}.sslVerify=true`,
      '-c', `http.${ENDPOINT}.followRedirects=false`,
      '-c', `http.${ENDPOINT}.extraHeader=`, '-c', `http.${ENDPOINT}.cookieFile=`,
      '-c', `http.${ENDPOINT}.saveCookies=false`,
      '-c', `http.${ENDPOINT}.emptyAuth=false`, '-c', `http.${ENDPOINT}.delegation=none`, '-c', `http.${ENDPOINT}.sslAutoClientCert=false`,
      '-c', 'credential.helper=!broker nonce',
      'push', '--', ENDPOINT, `${SHA}:refs/heads/published`,
    ]);
    expect(call.args).not.toContain('publish');
    expect(call.options).toMatchObject({ shell: false, windowsHide: true, detached: true });
    expect(call.options.env).toEqual({
      PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    });
    expect(JSON.stringify(result)).not.toContain('top-secret');
    expect(result.transport.actor).toEqual({
      kind: 'provider', provider: 'gitlab', instance: 'https://example.com', accountId: 'https://example.com#42',
    });
    expect(setupValue.credentialBroker.revoke).toHaveBeenCalledWith(plan.operationId);
  });

  it('configures the exact local upstream only after a successful push', async () => {
    const setupValue = setup();
    const plan = await setupValue.service.plan(request('push', { configureUpstream: true }));

    const result = await setupValue.service.execute(plan.operationId);

    expect(result.state).toBe('succeeded');
    expect(result.completedSteps).toEqual(['validated', 'authenticated', 'transferred', 'updated-local-repository']);
    expect(setupValue.calls.filter((call) => !call.args.includes('rev-list')).map((call) => call.args.slice(-3))).toEqual([
      ['--', ENDPOINT, `${SHA}:refs/heads/published`],
      ['config', 'branch.feature.remote', 'publish'],
      ['config', 'branch.feature.merge', 'refs/heads/published'],
    ]);
  });

  it('reports partial when upstream configuration fails after a successful push', async () => {
    const setupValue = setup({ spawnResults: [{ code: 0 }, { code: 1 }] });
    const plan = await setupValue.service.plan(request('push', { configureUpstream: true }));

    const result = await setupValue.service.execute(plan.operationId);

    expect(result.state).toBe('partial');
    expect(result.completedSteps).toContain('transferred');
    expect(result.error).toEqual({
      code: 'TRANSPORT_FAILED',
      message: 'Push succeeded, but local upstream configuration failed',
    });
    expect(setupValue.calls).toHaveLength(3);
  });

  it('deletes one exact remote branch through the push transport', async () => {
    const setupValue = setup();
    const input = request();
    delete input.sourceRef;
    input.operation = 'delete-remote-branch';
    const plan = await setupValue.service.plan(input);

    const result = await setupValue.service.execute(plan.operationId);

    expect(result.state).toBe('succeeded');
    expect(setupValue.calls).toHaveLength(1);
    expect(setupValue.calls[0].args.slice(-4)).toEqual([
      'push', '--', ENDPOINT, ':refs/heads/published',
    ]);
  });

  it('resets each discovered CA and client certificate setting by its exact key', async () => {
    const configuredKeys = [
      'http.sslCAInfo', 'http.sslCAPath', 'http.sslCert', 'http.sslCertType', 'http.sslCertPasswordProtected',
      `http.${ENDPOINT}/info.sslKey`, `http.${ENDPOINT}/info.sslKeyType`,
    ];
    const setupValue = setup({ enumerateManagedConfigKeys: vi.fn(async () => configuredKeys) });
    const plan = await setupValue.service.plan(request());
    await setupValue.service.execute(plan.operationId);
    const args = setupValue.calls.find((call) => call.args.includes('push')).args;
    for (const key of configuredKeys) {
      const expected = key.toLowerCase().endsWith('sslcertpasswordprotected') ? 'false' : '';
      expect(args).toContain(`${key}=${expected}`);
    }
  });

  it('adds only the requested force lease and preserves system transport configuration as unverified', async () => {
    const managed = setup();
    const plan = await managed.service.plan(request('push', { forceWithLease: { expectedRemoteSha: 'b'.repeat(40) } }));
    await managed.service.execute(plan.operationId);
    expect(managed.calls.find((call) => call.args.includes('push')).args).toContain(`--force-with-lease=refs/heads/published:${'b'.repeat(40)}`);

    const inherited = {
      GIT_ASKPASS: 'user-helper',
      GIT_SSH_COMMAND: 'user-wrapper',
      SSH_AUTH_SOCK: '/agent',
      HTTPS_PROXY: 'http://user-proxy.example',
      GIT_TRACE_CURL: '/tmp/user-git-trace',
      CURL_CA_BUNDLE: '/tmp/user-ca.pem',
      GIT_SSL_CERT: '/tmp/user-client-cert.pem',
    };
    const system = setup({ mode: 'system', env: inherited });
    const systemPlan = await system.service.plan(request('fetch', { transportMode: 'system' }));
    await system.service.execute(systemPlan.operationId);
    expect(systemPlan.transport).toEqual({ mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } });
    expect(system.calls[0].options.env).toEqual(inherited);
    expect(system.calls[0].args).toEqual(['fetch', '--no-tags', '--', ENDPOINT, 'refs/heads/feature:refs/heads/published']);
    expect(system.credentialBroker.start).not.toHaveBeenCalled();
  });

  it('pins managed SSH to one verified key without config or agent fallback', async () => {
    const setupValue = setup({ transport: 'ssh', env: { SSH_AUTH_SOCK: '/agent', HOME: '/home/user' } });
    const input = request('fetch', {
      remote: {
        name: 'publish',
        endpoint: { displayUrl: 'git@example.com:owner/repository.git', fingerprint: setupValue.authority.endpointFingerprint },
      },
    });
    const plan = await setupValue.service.plan(input);
    await setupValue.service.execute(plan.operationId);
    expect(setupValue.calls[0].options.env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      OPENCHAMBER_GIT_SSH_KEY: '/keys/selected key',
      GIT_SSH_VARIANT: 'ssh',
    });
    expect(setupValue.calls[0].options.env.GIT_SSH_COMMAND).not.toContain('/keys/selected key');
    expect(setupValue.calls[0].options.env).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(setupValue.credentialBroker.start).not.toHaveBeenCalled();
  });

  it('keeps SSH key path shell metacharacters out of the command string', async () => {
    const keyPath = "/keys/space $() `tick` ' quote";
    const setupValue = setup({ transport: 'ssh', keyPath });
    const plan = await setupValue.service.plan(request('fetch', {
      remote: {
        name: 'publish',
        endpoint: { displayUrl: 'git@example.com:owner/repository.git', fingerprint: setupValue.authority.endpointFingerprint },
      },
    }));
    await setupValue.service.execute(plan.operationId);

    expect(setupValue.calls[0].options.env.OPENCHAMBER_GIT_SSH_KEY).toBe(keyPath);
    expect(setupValue.calls[0].options.env.GIT_SSH_COMMAND).not.toContain(keyPath);
    expect(setupValue.calls[0].options.shell).toBe(false);
  });

  it('rejects config, remote, or source changes before spawning', async () => {
    const setupValue = setup();
    const plan = await setupValue.service.plan(request());
    setupValue.validateGitTransportContext.mockResolvedValueOnce({ ...setupValue.authority, endpoint: 'https://example.com/changed.git' });
    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({ state: 'conflicted', error: { code: 'REMOTE_CHANGED' } });
    expect(setupValue.calls).toHaveLength(0);

    const source = setup();
    const sourcePlan = await source.service.plan(request());
    source.resolveRef.mockResolvedValueOnce('b'.repeat(40));
    await expect(source.service.execute(sourcePlan.operationId)).resolves.toMatchObject({ state: 'conflicted', error: { code: 'STALE_CONFIG' } });
    expect(source.calls).toHaveLength(0);
  });

  it('runs checkout hydration as a pinned operation and marks retained setup ready only after success', async () => {
    const onCheckoutHydrated = vi.fn(async () => {});
    const auditStore = {
      plan: vi.fn(async (record) => ({ status: 'planned', record })),
      start: vi.fn(async () => {}), finish: vi.fn(async () => {}),
    };
    const setupValue = setup({
      onCheckoutHydrated,
      auditStore,
      spawnResponder: ({ args }) => {
        const command = args.join(' ');
        if (command.includes('rev-parse --verify HEAD')) return { code: 0, stdout: SHA };
        if (command.includes('config --blob HEAD:.gitmodules')) return { code: 1 };
        if (command.includes('ls-tree -rz') || command.includes('ls-files -z')) return { code: 0 };
        return { code: 1 };
      },
    });
    const plan = await setupValue.service.plan({
      operation: 'checkout-hydration', directory: '/repository', repositoryId: 'repo_one',
      bindingRevision: 2, configRevision: 'config_one', remote: request('fetch').remote,
    });

    expect(plan.target).toMatchObject({ operation: 'checkout-hydration', requirements: [] });
    const result = await setupValue.service.execute(plan.operationId);
    expect(result).toMatchObject({ state: 'succeeded', hydration: { status: 'not-needed' } });
    expect(onCheckoutHydrated).toHaveBeenCalledExactlyOnceWith('/repository');
    expect(setupValue.calls.some((call) => call.args.includes('clone') || call.args.includes('fetch'))).toBe(false);
    expect(auditStore.plan).toHaveBeenCalledWith(expect.objectContaining({
      providerAccountId: null,
      transportReference: null,
      target: { kind: 'git-network', operation: 'checkout-hydration', remotes: [], auxiliaries: [] },
    }));
    expect(auditStore.finish).toHaveBeenCalledWith('git:git_operation_one', {
      state: 'succeeded', errorCode: null, steps: ['validated', 'checked-out'],
    });
  });

  it('audits manual hydration with only its server-validated child grant and revalidates it', async () => {
    const childEndpoint = 'https://modules.example.net/team/child.git';
    const childCredential = createHttpsCredentialReference({
      provider: 'github', instance: 'github.com', credentialId: 'child-account',
      credentialRevision: 3, providerUserId: 'github.com#child-user',
    });
    let childTransportRevision = 'child-transport';
    const validateGitAuxiliaryContext = vi.fn(async ({ kind, rawEndpoint }) => ({
      endpoint: rawEndpoint,
      endpointFingerprint: fingerprintRemoteUrl(rawEndpoint),
      transportMode: 'managed',
      transportRevision: childTransportRevision,
      credentialId: childCredential,
      kind,
    }));
    const auditStore = {
      plan: vi.fn(async (record) => ({ status: 'planned', record })),
      start: vi.fn(async () => {}), finish: vi.fn(async () => {}),
    };
    const operation = setup({
      credentialId: 'parent-credential-must-not-be-audited',
      validateGitAuxiliaryContext,
      auditStore,
      spawnResponder: ({ args }) => {
        const command = args.join(' ');
        if (command.includes('rev-parse --verify HEAD')) return { code: 0, stdout: SHA };
        if (command.includes('config --blob HEAD:.gitmodules')) {
          return { code: 0, stdout: `submodule.child.path\nvendor/child\0submodule.child.url\n${childEndpoint}\0` };
        }
        if (command.includes('ls-tree -rz')) return { code: 0, stdout: `160000 commit ${SHA}\tvendor/child\0` };
        if (command.includes('ls-files -z')) return { code: 0 };
        return { code: 1 };
      },
    });

    const planned = await operation.service.plan({
      operation: 'checkout-hydration', directory: '/repository', repositoryId: 'repo_one',
      bindingRevision: 2, configRevision: 'config_one', remote: request('fetch').remote,
    });

    expect(planned.target.requirements).toEqual([{
      kind: 'submodule', path: 'vendor/child',
      endpoint: { displayUrl: childEndpoint, fingerprint: fingerprintRemoteUrl(childEndpoint) },
    }]);
    expect(auditStore.plan).toHaveBeenCalledWith(expect.objectContaining({
      providerAccountId: null,
      transportReference: { kind: 'auxiliary', entries: [{
        kind: 'submodule', endpointFingerprint: fingerprintRemoteUrl(childEndpoint),
        transport: { kind: 'managed', credentialId: childCredential },
      }] },
      target: { kind: 'git-network', operation: 'checkout-hydration', remotes: [], auxiliaries: [{
        kind: 'submodule', endpointFingerprint: fingerprintRemoteUrl(childEndpoint),
      }] },
    }));
    expect(JSON.stringify(auditStore.plan.mock.calls)).not.toMatch(/parent-credential|modules\.example|vendor\/child/);

    childTransportRevision = 'changed-child-transport';
    await expect(operation.service.execute(planned.operationId)).resolves.toMatchObject({
      state: 'failed', hydration: { status: 'failed' }, error: { code: 'TRANSPORT_FAILED' },
    });
    expect(operation.calls.some((call) => call.args.includes('clone'))).toBe(false);
    expect(operation.credentialResolver.resolve).not.toHaveBeenCalled();
  });

  it('keeps initial worktree hydration separate from retained-checkout repair completion', async () => {
    const onCheckoutHydrated = vi.fn(async () => {});
    const snapshots = [];
    const operationStore = {
      recover: vi.fn(async () => []), read: vi.fn(async () => null),
      claim: vi.fn(async (snapshot) => { snapshots.push(snapshot); return snapshot; }),
      update: vi.fn(async (_operationId, input) => { snapshots.push(input.snapshot); return input.snapshot; }),
    };
    const auditStore = {
      plan: vi.fn(async (record) => ({ status: 'planned', record })),
      start: vi.fn(async () => {}), finish: vi.fn(async () => {}),
    };
    const setupValue = setup({
      onCheckoutHydrated,
      auditStore,
      operationStore,
      spawnResponder: ({ args }) => {
        const command = args.join(' ');
        if (command.includes('rev-parse --verify HEAD')) return { code: 0, stdout: SHA };
        if (command.includes('config --blob HEAD:.gitmodules')) return { code: 1 };
        if (command.includes('ls-tree -rz') || command.includes('ls-files -z')) return { code: 0 };
        return { code: 1 };
      },
    });

    await expect(setupValue.service.hydrateBoundCheckout({
      directory: '/repository', parentRemoteName: 'publish',
      repositoryAuthority: { repositoryId: 'repo_one', bindingRevision: 2, configRevision: 'config_one' },
    })).resolves.toMatchObject({ status: 'not-needed' });
    expect(onCheckoutHydrated).not.toHaveBeenCalled();
    expect(auditStore.plan).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: 'repo_one', providerAccountId: null, transportReference: null,
      target: { kind: 'git-network', operation: 'checkout-hydration', remotes: [], auxiliaries: [] },
    }));
    expect(snapshots.at(-1)).toMatchObject({
      state: 'succeeded', transport: null, completedSteps: ['validated', 'checked-out'], hydration: { status: 'not-needed' },
    });
    expect(snapshots.some((snapshot) => snapshot.completedSteps.includes('authenticated')
      || snapshot.completedSteps.includes('transferred'))).toBe(false);
  });

  it('hydrates submodules from the explicit parent authority and preserves an authorized sibling', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-submodule-siblings-'));
    temporaryDirectories.push(root);
    const alphaEndpoint = 'https://example.com/owner/alpha.git';
    const betaEndpoint = 'https://objects.example.net/team/beta.git';
    const manifest = [
      'submodule.alpha.path\nvendor/alpha\0',
      'submodule.alpha.url\n../alpha.git\0',
      'submodule.beta.path\nvendor/beta\0',
      `submodule.beta.url\n${betaEndpoint}\0`,
    ].join('');
    const validateGitAuxiliaryContext = vi.fn(async ({ rawEndpoint }) => {
      if (rawEndpoint === betaEndpoint) {
        throw Object.assign(new Error('private grant detail'), { code: 'GIT_AUXILIARY_AUTHORIZATION_REQUIRED' });
      }
      return {
        endpoint: rawEndpoint,
        endpointFingerprint: fingerprintRemoteUrl(rawEndpoint),
        transportMode: 'managed',
        credentialId: 'alpha-endpoint-credential',
        transportRevision: 'transport_one',
      };
    });
    const auditStore = {
      plan: vi.fn(async (record) => ({ status: 'planned', record })),
      start: vi.fn(async () => {}), finish: vi.fn(async () => {}),
    };
    const setupValue = setup({
      validateGitAuxiliaryContext,
      auditStore,
      spawnResponder: ({ args, options }) => {
        const command = args.join(' ');
        if (command.includes('config --blob HEAD:.gitmodules')) {
          return options.cwd === root ? { code: 0, stdout: manifest } : { code: 1 };
        }
        if (command.includes('ls-tree -rz')) return options.cwd === root ? {
          code: 0,
          stdout: `160000 commit ${'b'.repeat(40)}\tvendor/alpha\0` + `160000 commit ${'c'.repeat(40)}\tvendor/beta\0`,
        } : { code: 0 };
        if (command.includes('rev-parse --verify HEAD') && options.cwd.endsWith('vendor/alpha')) {
          return { code: 0, stdout: 'b'.repeat(40) };
        }
        if (command.includes('ls-files -z')) return { code: 0 };
        if (command.includes('HEAD:.lfsconfig') || command.includes('config --includes')) return { code: 1 };
        if (command.includes('lfs version')) return { code: 1 };
        return { code: 0 };
      },
    });

    const result = await setupValue.service.hydrateBoundCheckout({
      directory: root, parentRemoteName: 'publish',
      repositoryAuthority: { repositoryId: 'repo_one', bindingRevision: 2, configRevision: 'config_one' },
    });

    expect(result).toMatchObject({
      status: 'authorization-required',
      submodules: [
        { path: 'vendor/alpha', status: 'succeeded', endpoint: { displayUrl: alphaEndpoint } },
        { path: 'vendor/beta', status: 'authorization-required', endpoint: { displayUrl: betaEndpoint } },
      ],
    });
    expect(setupValue.calls.filter((call) => call.args.includes('clone')).map((call) => call.args))
      .toEqual([expect.arrayContaining([alphaEndpoint])]);
    expect(setupValue.credentialResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: 'alpha-endpoint-credential',
    }));
    expect(auditStore.plan).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: 'repo_one', providerAccountId: null,
      transportReference: { kind: 'auxiliary', entries: [{
        kind: 'submodule', endpointFingerprint: fingerprintRemoteUrl(alphaEndpoint),
        transport: { kind: 'managed', credentialId: 'alpha-endpoint-credential' },
      }] },
      target: { kind: 'git-network', operation: 'checkout-hydration', remotes: [], auxiliaries: [
        { kind: 'submodule', endpointFingerprint: fingerprintRemoteUrl(alphaEndpoint) },
        { kind: 'submodule', endpointFingerprint: fingerprintRemoteUrl(betaEndpoint) },
      ] },
    }));
    expect(auditStore.finish).toHaveBeenCalledWith(expect.stringMatching(/^git:/), {
      state: 'failed', errorCode: 'AUTHENTICATION_REQUIRED', steps: ['validated', 'authenticated', 'transferred'],
    });
    expect(JSON.stringify(auditStore.plan.mock.calls)).not.toMatch(/example\.com\/owner|objects\.example|vendor\/|opaque-credential|top-secret/);
    await expect(fs.lstat(path.join(root, 'vendor', 'alpha'))).resolves.toMatchObject({});
    expect(JSON.stringify(result)).not.toContain('private grant detail');
  });

  it('fails a submodule whose checkout HEAD does not equal the gitlink', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-submodule-mismatch-'));
    temporaryDirectories.push(root);
    const manifest = 'submodule.alpha.path\nvendor/alpha\0submodule.alpha.url\n../alpha.git\0';
    const setupValue = setup({
      validateGitAuxiliaryContext: vi.fn(async ({ rawEndpoint }) => ({
        endpoint: rawEndpoint, endpointFingerprint: fingerprintRemoteUrl(rawEndpoint),
        transportMode: 'managed', credentialId: 'child-credential', transportRevision: 'transport_one',
      })),
      spawnResponder: ({ args, options }) => {
        const command = args.join(' ');
        if (command.includes('config --blob HEAD:.gitmodules')) return options.cwd === root ? { code: 0, stdout: manifest } : { code: 1 };
        if (command.includes('ls-tree -rz')) return options.cwd === root
          ? { code: 0, stdout: `160000 commit ${'b'.repeat(40)}\tvendor/alpha\0` }
          : { code: 0 };
        if (command.includes('rev-parse --verify HEAD')) return { code: 0, stdout: 'c'.repeat(40) };
        if (command.includes('ls-files -z')) return { code: 0 };
        if (command.includes('HEAD:.lfsconfig') || command.includes('config --includes')) return { code: 1 };
        if (command.includes('lfs version')) return { code: 1 };
        return { code: 0 };
      },
    });

    const result = await setupValue.service.hydrateBoundCheckout({
      directory: root, parentRemoteName: 'publish',
      repositoryAuthority: { repositoryId: 'repo_one', bindingRevision: 2, configRevision: 'config_one' },
    });

    expect(result).toMatchObject({
      status: 'invalid',
      submodules: [{ path: 'vendor/alpha', status: 'invalid', error: { code: 'INVALID_REQUEST' } }],
    });
  });

  it('quarantines and removes an operation-created child after clone failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-submodule-cleanup-'));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, 'vendor'));
    const manifest = 'submodule.alpha.path\nvendor/alpha\0submodule.alpha.url\n../alpha.git\0';
    const setupValue = setup({
      validateGitAuxiliaryContext: vi.fn(async ({ rawEndpoint }) => ({
        endpoint: rawEndpoint, endpointFingerprint: fingerprintRemoteUrl(rawEndpoint),
        transportMode: 'managed', credentialId: 'child-credential', transportRevision: 'transport_one',
      })),
      spawnResponder: ({ args, options }) => {
        const command = args.join(' ');
        if (command.includes('config --blob HEAD:.gitmodules')) return options.cwd === root ? { code: 0, stdout: manifest } : { code: 1 };
        if (command.includes('ls-tree -rz')) {
          return options.cwd === root ? { code: 0, stdout: `160000 commit ${'b'.repeat(40)}\tvendor/alpha\0` } : { code: 0 };
        }
        if (command.includes('ls-files -z')) return { code: 0 };
        if (command.includes('clone --no-checkout')) return { code: 1, stderr: 'clone failed' };
        return { code: 0 };
      },
    });

    const result = await setupValue.service.hydrateBoundCheckout({
      directory: root, parentRemoteName: 'publish',
      repositoryAuthority: { repositoryId: 'repo_one', bindingRevision: 2, configRevision: 'config_one' },
    });

    expect(result).toMatchObject({
      status: 'failed', submodules: [{ path: 'vendor/alpha', status: 'failed', error: { code: 'TRANSPORT_FAILED' } }],
    });
    await expect(fs.lstat(path.join(root, 'vendor', 'alpha'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(root)).some((name) => name.startsWith('.openchamber-quarantine-'))).toBe(false);
  });

  it('does not report a hydrated child when its credential cleanup fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-submodule-credential-cleanup-'));
    temporaryDirectories.push(root);
    const manifest = 'submodule.alpha.path\nvendor/alpha\0submodule.alpha.url\n../alpha.git\0';
    const setupValue = setup({
      validateGitAuxiliaryContext: vi.fn(async ({ rawEndpoint }) => ({
        endpoint: rawEndpoint, endpointFingerprint: fingerprintRemoteUrl(rawEndpoint),
        transportMode: 'managed', credentialId: 'child-credential', transportRevision: 'transport_one',
      })),
      spawnResponder: ({ args, options }) => {
        const command = args.join(' ');
        if (command.includes('config --blob HEAD:.gitmodules')) return options.cwd === root ? { code: 0, stdout: manifest } : { code: 1 };
        if (command.includes('ls-tree -rz')) return options.cwd === root
          ? { code: 0, stdout: `160000 commit ${'b'.repeat(40)}\tvendor/alpha\0` }
          : { code: 0 };
        if (command.includes('rev-parse --verify HEAD')) return { code: 0, stdout: 'b'.repeat(40) };
        if (command.includes('ls-files -z')) return { code: 0 };
        return { code: 0 };
      },
    });
    setupValue.credentialBroker.issue.mockReturnValue({
      gitConfigArgs: [], revoke: () => { throw new Error('private cleanup failure'); },
    });

    const result = await setupValue.service.hydrateBoundCheckout({
      directory: root, parentRemoteName: 'publish',
      repositoryAuthority: { repositoryId: 'repo_one', bindingRevision: 2, configRevision: 'config_one' },
    });

    expect(result).toMatchObject({
      status: 'failed', submodules: [{ path: 'vendor/alpha', status: 'failed', error: { code: 'TRANSPORT_FAILED' } }],
    });
    expect(result.submodules).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private cleanup failure');
  });

  it('reuses an existing exact submodule checkout during repair without another transfer', async () => {
    const childDirectory = '/repository/vendor/alpha';
    const manifest = 'submodule.alpha.path\nvendor/alpha\0submodule.alpha.url\n../alpha.git\0';
    const directoryStats = { isDirectory: () => true, isSymbolicLink: () => false };
    const validateGitAuxiliaryContext = vi.fn(async () => {
      throw new Error('An existing exact checkout must not require transfer authority');
    });
    const setupValue = setup({
      validateGitAuxiliaryContext,
      fsImpl: { ...fs, lstat: vi.fn(async (target) => ['/repository/vendor', childDirectory].includes(target)
        ? directoryStats
        : fs.lstat(target)) },
      spawnResponder: ({ args, options }) => {
        const command = args.join(' ');
        if (command.includes('config --blob HEAD:.gitmodules')) {
          return options.cwd === '/repository' ? { code: 0, stdout: manifest } : { code: 1 };
        }
        if (command.includes('ls-tree -rz')) return options.cwd === '/repository'
          ? { code: 0, stdout: `160000 commit ${'b'.repeat(40)}\tvendor/alpha\0` }
          : { code: 0 };
        if (command.includes('rev-parse --verify HEAD') && options.cwd === childDirectory) {
          return { code: 0, stdout: 'b'.repeat(40) };
        }
        if (command.includes('ls-files -z')) return { code: 0 };
        if (command.includes('HEAD:.lfsconfig') || command.includes('config --includes')) return { code: 1 };
        if (command.includes('lfs version')) return { code: 1 };
        return { code: 0 };
      },
    });

    const result = await setupValue.service.hydrateBoundCheckout({
      directory: '/repository', parentRemoteName: 'publish',
      repositoryAuthority: { repositoryId: 'repo_one', bindingRevision: 2, configRevision: 'config_one' },
    });

    expect(result).toMatchObject({
      status: 'succeeded', submodules: [{ path: 'vendor/alpha', status: 'succeeded' }],
    });
    expect(setupValue.calls.some((call) => call.args.includes('clone'))).toBe(false);
    expect(validateGitAuxiliaryContext).not.toHaveBeenCalled();
  });

  it('inspects already-present nested checkouts without network activity', async () => {
    const childDirectory = '/repository/vendor/alpha';
    const rootManifest = 'submodule.alpha.path\nvendor/alpha\0submodule.alpha.url\n../alpha.git\0';
    const childManifest = 'submodule.nested.path\nnested\0submodule.nested.url\n../nested.git\0';
    const directoryStats = { isDirectory: () => true, isSymbolicLink: () => false };
    const setupValue = setup({
      fsImpl: { ...fs, lstat: vi.fn(async (target) => ['/repository/vendor', childDirectory].includes(target)
        ? directoryStats
        : fs.lstat(target)) },
      spawnResponder: ({ args, options }) => {
        const command = args.join(' ');
        if (command.includes('rev-parse --verify HEAD')) {
          return { code: 0, stdout: options.cwd === childDirectory ? 'b'.repeat(40) : SHA };
        }
        if (command.includes('config --blob HEAD:.gitmodules')) {
          return { code: 0, stdout: options.cwd === childDirectory ? childManifest : rootManifest };
        }
        if (command.includes('ls-tree -rz')) return { code: 0, stdout: options.cwd === childDirectory
          ? `160000 commit ${'c'.repeat(40)}\tnested\0`
          : `160000 commit ${'b'.repeat(40)}\tvendor/alpha\0` };
        if (command.includes('ls-files -z')) return { code: 0 };
        return { code: 1 };
      },
    });

    const result = await setupValue.service.inspectCheckoutHydration({
      directory: '/repository', parentEndpoint: ENDPOINT, parentRemoteName: 'publish',
    });

    expect(result).toEqual({
      headSha: SHA,
      requirements: [
        { kind: 'submodule', path: 'vendor/alpha/nested', endpoint: {
          displayUrl: 'https://example.com/owner/nested.git',
          fingerprint: fingerprintRemoteUrl('https://example.com/owner/nested.git'),
        } },
      ],
    });
    expect(setupValue.calls.some((call) => call.args.includes('clone') || call.args.includes('fetch'))).toBe(false);
    expect(setupValue.credentialResolver.resolve).not.toHaveBeenCalled();
  });

  it('rejects a symlinked submodule parent without starting auxiliary transport', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-submodule-symlink-'));
    temporaryDirectories.push(root);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-submodule-outside-'));
    temporaryDirectories.push(outside);
    await fs.symlink(outside, path.join(root, 'vendor'));
    const validateGitAuxiliaryContext = vi.fn(async () => {
      throw new Error('Symlinked checkout paths must fail before authorization');
    });
    const manifest = 'submodule.alpha.path\nvendor/alpha\0submodule.alpha.url\n../alpha.git\0';
    const setupValue = setup({
      validateGitAuxiliaryContext,
      spawnResponder: ({ args }) => {
        const command = args.join(' ');
        if (command.includes('config --blob HEAD:.gitmodules')) return { code: 0, stdout: manifest };
        if (command.includes('ls-tree -rz')) {
          return { code: 0, stdout: `160000 commit ${'b'.repeat(40)}\tvendor/alpha\0` };
        }
        if (command.includes('ls-files -z')) return { code: 0 };
        if (command.includes('rev-parse --verify HEAD')) return { code: 0, stdout: SHA };
        return { code: 1 };
      },
    });

    const result = await setupValue.service.hydrateBoundCheckout({
      directory: root, parentRemoteName: 'publish',
      repositoryAuthority: { repositoryId: 'repo_one', bindingRevision: 2, configRevision: 'config_one' },
    });

    expect(result).toMatchObject({
      status: 'invalid', submodules: [{ path: 'vendor/alpha', status: 'invalid', error: { code: 'INVALID_REQUEST' } }],
    });
    expect(validateGitAuxiliaryContext).not.toHaveBeenCalled();
    expect(setupValue.calls.some((call) => call.args.includes('clone'))).toBe(false);
  });

  it('checks local content before requiring a parent fetch authority', async () => {
    const setupValue = setup();
    const result = await setupValue.service.hydrateBoundCheckout({
      directory: '/repository',
      repositoryAuthority: { repositoryId: 'repo_one', bindingRevision: 2, configRevision: 'config_one' },
    });
    expect(result).toMatchObject({ status: 'not-needed' });
    expect(setupValue.validateGitTransportContext).not.toHaveBeenCalled();
    expect(setupValue.calls).toHaveLength(13);
    expect(setupValue.credentialResolver.resolve).not.toHaveBeenCalled();
  });

  it.each(['ordinary', 'lfs', 'submodule'])('creates a bound local HEAD worktree with truthful $0 hydration', async (kind) => {
    const { createWorktree, getWorktreeBootstrapStatus } = await import('./service.js');
    const { parent, directory, env, git } = await createLocalRepository();
    if (kind === 'lfs') {
      await fs.writeFile(path.join(directory, 'asset.bin'), `version https://git-lfs.github.com/spec/v1\noid sha256:${'d'.repeat(64)}\nsize 12\n`);
      await git('add', 'asset.bin');
      await git('commit', '-m', 'LFS pointer without attributes');
    } else if (kind === 'submodule') {
      await fs.writeFile(path.join(directory, '.gitmodules'), '[submodule "child"]\npath = vendor/child\nurl = ../child.git\n');
      await git('add', '.gitmodules');
      await git('update-index', '--add', '--cacheinfo', `160000,${await git('rev-parse', 'HEAD')},vendor/child`);
      await git('commit', '-m', 'submodule');
    }
    const validateGitTransportContext = vi.fn(async () => { throw new Error('Must not infer a parent source from a binding'); });
    const credentialResolver = { resolve: vi.fn(async () => { throw new Error('No transfer authorized'); }) };
    const calls = [];
    const operations = createNetworkOperations({
      validateGitTransportContext, credentialResolver, inheritedEnv: env,
      systemPushAcknowledgements: { isAcknowledged: async () => true, acknowledge: async () => {} },
      runtimeIdentity: { id: 'fixture', platform: 'web' },
      spawnImpl: (binary, args, options) => {
        calls.push(args);
        expect(options.env.GIT_ALLOW_PROTOCOL).toBe('');
        expect(options.env.GIT_NO_LAZY_FETCH).toBe('1');
        return spawn(binary, args, options);
      },
    });
    vi.stubEnv('XDG_DATA_HOME', parent);
    const started = performance.now();
    try {
      const created = await createWorktree(directory, {
        mode: 'new', branchName: `local-${kind}`, worktreeName: `local-${kind}`, startRef: 'HEAD',
        returnAfterDirectoryCreated: true,
      }, {
        hydrateCheckout: (input) => operations.hydrateBoundCheckout({
          ...input, repositoryAuthority: { repositoryId: 'bound-local', bindingRevision: 1, configRevision: 'local' },
        }),
      });
      await expect.poll(async () => (await getWorktreeBootstrapStatus(created.path)).status, { timeout: 10_000 })
        .toBe(kind === 'ordinary' ? 'ready' : 'failed');
      const result = await getWorktreeBootstrapStatus(created.path);
      if (kind === 'ordinary') {
        expect(result.phase).toBe('setup-ready');
        expect(await fs.readFile(path.join(created.path, 'README.md'), 'utf8')).toBe('ordinary content\n');
      } else {
        expect(result).toMatchObject({ status: 'failed', phase: 'directory-created', errorCode: 'AUTHENTICATION_REQUIRED' });
        const entries = kind === 'lfs' ? result.hydration.lfs : result.hydration.submodules;
        expect(entries).toEqual([expect.objectContaining({
          path: kind === 'lfs' ? '.' : 'vendor/child', status: 'authorization-required',
          error: { code: 'AUTHENTICATION_REQUIRED', message: expect.stringContaining('exact parent fetch source') },
        })]);
      }
      expect(validateGitTransportContext).not.toHaveBeenCalled();
      expect(credentialResolver.resolve).not.toHaveBeenCalled();
      expect(calls.some((args) => args.includes('fetch') || args.includes('clone') || args.includes('lfs'))).toBe(false);
      console.info(JSON.stringify({ scenario: 'local-worktree-hydration', kind, commands: calls.length,
        elapsedMs: Math.round(performance.now() - started), state: result.status, transfers: 0 }));
    } finally {
      vi.unstubAllEnvs();
    }
  }, 20_000);

  it.each(['smudge', 'process'])('prevents managed sync %s filters and hooks from contacting a network listener', async (filter) => {
    const { parent, directory, env, git } = await createLocalRepository();
    await git('checkout', '-b', 'incoming');
    await fs.writeFile(path.join(directory, '.gitattributes'), '*.bin filter=custom\n');
    await fs.writeFile(path.join(directory, 'asset.bin'), 'incoming content\n');
    await git('add', '.');
    await git('commit', '-m', 'incoming');
    const incomingSha = await git('rev-parse', 'HEAD');
    await git('checkout', 'published');
    await fs.writeFile(path.join(directory, 'local.txt'), 'keep local commit\n');
    await git('add', '.');
    await git('commit', '-m', 'local');
    const oldHead = await git('rev-parse', 'HEAD');
    const requests = [];
    const server = http.createServer((req, res) => { requests.push(req.url); res.end('ok'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const executable = path.join(parent, 'network-filter.cjs');
    const marker = path.join(parent, 'executed');
    await fs.writeFile(executable, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'executed'); require('node:http').get('http://127.0.0.1:${server.address().port}/attempt', r => r.resume());\n`);
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(executable)}`;
    const include = path.join(parent, 'filters.config');
    await fs.writeFile(include, `[filter "custom"]\n${filter} = ${JSON.stringify(command)}\nclean = ${JSON.stringify(command)}\nrequired = true\n`);
    await git('config', 'include.path', include);
    await git('config', 'submodule.recurse', 'true');
    for (const hook of ['post-merge', 'pre-merge-commit', 'reference-transaction']) {
      await fs.writeFile(path.join(directory, '.git', 'hooks', hook), `#!/bin/sh\n${command}\n`, { mode: 0o700 });
    }
    const calls = [];
    const credentialBroker = {
      start: vi.fn(async () => {}), issue: vi.fn(() => ({ gitConfigArgs: [], revoke: vi.fn() })), revoke: vi.fn(),
    };
    const operations = createNetworkOperations({
      validateGitTransportContext: async () => ({ endpoint: ENDPOINT, endpointFingerprint: fingerprintRemoteUrl(ENDPOINT),
        transportMode: 'managed', transportRevision: 'one', credentialId: 'selected' }),
      systemPushAcknowledgements: { isAcknowledged: async () => true, acknowledge: async () => {} },
      credentialResolver: { resolve: async () => ({ transport: 'https', username: 'fixture', password: 'fixture' }) },
      credentialBroker, inheritedEnv: { ...env, GIT_ASKPASS: executable, SSH_AUTH_SOCK: '/ambient-agent' },
      runtimeIdentity: { id: 'fixture', platform: 'web' },
      spawnImpl: (binary, args, options) => {
        calls.push({ args, options });
        // Transfers use locally seeded objects; integration and discovery run real Git unchanged.
        const transfer = args.findIndex((arg) => arg === 'fetch' || arg === 'push');
        if (transfer >= 0) {
          const replacement = args[transfer] === 'fetch'
            ? ['update-ref', args.at(-1).split(':')[1], incomingSha] : ['rev-parse', 'HEAD'];
          return spawn(binary, [...args.slice(0, transfer), ...replacement], options);
        }
        return spawn(binary, args, options);
      },
    });
    try {
      const plan = await operations.plan(syncRequest({ directory }));
      const started = performance.now();
      const result = await operations.execute(plan.operationId);
      expect(result, JSON.stringify(result)).toMatchObject({ state: 'succeeded', stepResults: [
        { step: 'fetch', status: 'succeeded' }, { step: 'pull', status: 'succeeded' }, { step: 'push', status: 'succeeded' },
      ] });
      expect(await git('rev-parse', 'HEAD^1')).toBe(oldHead);
      expect(await git('rev-parse', 'HEAD^2')).toBe(incomingSha);
      expect(await fs.readFile(path.join(directory, 'asset.bin'), 'utf8')).toBe('incoming content\n');
      const merge = calls.find((call) => call.args.includes('merge'));
      expect(merge.options.env).toMatchObject({ GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' });
      expect(merge.options.env.GIT_ASKPASS).toBeUndefined();
      expect(merge.options.env.SSH_AUTH_SOCK).toBeUndefined();
      expect(merge.args).toEqual(expect.arrayContaining([`filter.custom.${filter}=`, 'filter.custom.clean=', 'filter.custom.required=false', 'submodule.recurse=false']));
      expect(calls.at(-1).args.at(-1)).toBe(`${await git('rev-parse', 'HEAD')}:refs/heads/published`);
      expect(requests).toEqual([]);
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      console.info(JSON.stringify({ scenario: 'managed-sync-local-boundary', filter, commands: calls.length,
        elapsedMs: Math.round(performance.now() - started), unauthorizedRequests: requests.length }));
      // Prove the configured executable can reach the listener when invoked without the boundary.
      await execFileAsync(process.execPath, [executable]);
      expect(requests).toEqual(['/attempt']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 20_000);

  it('preserves timeout separately from cancellation in hydration results', async () => {
    const setupValue = setup({ timeoutMs: 0 });
    const result = await setupValue.service.hydrateBoundCheckout({
      directory: '/repository', parentRemoteName: 'publish',
      repositoryAuthority: { repositoryId: 'repo_one', bindingRevision: 2, configRevision: 'config_one' },
    });
    expect(result).toMatchObject({
      status: 'cancelled',
      lfs: [{ status: 'cancelled', error: { code: 'TIMEOUT' } }],
    });
  });

  it('returns the stable missing git-lfs result without starting an LFS transfer', async () => {
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'d'.repeat(64)}\nsize 12\n`;
    const setupValue = setup({
      spawnResponder: ({ args }) => {
        const command = args.join(' ');
        if (command.includes('config --blob HEAD:.gitmodules')) return { code: 1 };
        if (command.includes('ls-tree -rz')) return { code: 0 };
        if (command.includes('ls-files -z')) return { code: 0, stdout: 'asset.bin\0' };
        if (command.includes('check-attr')) return { code: 0, stdout: 'asset.bin\0filter\0lfs\0' };
        if (command.includes('cat-file --batch-check')) return { code: 0, stdout: `${SHA} blob ${Buffer.byteLength(pointer)}\n` };
        if (command.includes('cat-file --batch')) return { code: 0, stdout: `${SHA} blob ${Buffer.byteLength(pointer)}\n${pointer}\n` };
        if (command.includes('HEAD:.lfsconfig') || command.includes('config --includes')) return { code: 1 };
        if (command.includes('lfs version')) return { code: 1, stderr: 'git-lfs is not installed at /private/bin' };
        return { code: 0 };
      },
    });

    const result = await setupValue.service.hydrateBoundCheckout({
      directory: '/repository', parentRemoteName: 'publish',
      repositoryAuthority: { repositoryId: 'repo_one', bindingRevision: 2, configRevision: 'config_one' },
    });

    expect(result).toEqual({
      status: 'client-missing',
      submodules: [],
      lfs: [{
        path: '.', status: 'client-missing',
        error: { code: 'GIT_LFS_CLIENT_MISSING', message: 'Git LFS is required for this checkout; install git-lfs and retry' },
      }],
    });
    expect(setupValue.calls.some((call) => call.args.includes('fetch') && call.args.includes('lfs'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('/private/bin');
  });

  it('rejects an incomplete attribute response instead of reporting not-needed', async () => {
    const files = Array.from({ length: 257 }, (_, index) => `asset-${index}.bin`);
    const setupValue = setup({
      spawnResponder: ({ args }) => {
        const command = args.join(' ');
        if (command.includes('config --blob HEAD:.gitmodules')) return { code: 1 };
        if (command.includes('ls-tree -rz')) return { code: 0 };
        if (command.includes('ls-files -z')) return { code: 0, stdout: `${files.join('\0')}\0` };
        if (command.includes('check-attr')) {
          return { code: 0, stdout: files.map((file) => `${file}\0filter\0unspecified\0`).join('') };
        }
        if (command.includes('show HEAD:')) return { code: 0, stdout: 'ordinary content' };
        if (command.includes('HEAD:.lfsconfig') || command.includes('config --includes')) return { code: 1 };
        if (command.includes('lfs version')) return { code: 1 };
        return { code: 0 };
      },
    });

    const result = await setupValue.service.hydrateBoundCheckout({
      directory: '/repository', parentRemoteName: 'publish',
      repositoryAuthority: { repositoryId: 'repo_one', bindingRevision: 2, configRevision: 'config_one' },
    });
    expect(result).toMatchObject({
      status: 'invalid',
      lfs: [{ path: '.', status: 'invalid', error: { code: 'INVALID_REQUEST' } }],
    });
  });

  it.each([
    { count: 257 }, { count: 1_025 }, { count: 10_000 },
    { count: 1_026, mixed: true }, { count: 1_026, mixed: true, latePointer: true },
  ])('clones a regular repository at scale $count, mixed=$mixed, pointer=$latePointer', async ({ count, mixed, latePointer }) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-lfs-scale-'));
    temporaryDirectories.push(parent);
    const source = path.join(parent, 'source');
    const destination = path.join(parent, 'checkout');
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_LFS_SKIP_SMUDGE: '1' };
    await execFileAsync('git', ['init', source], { env });
    // A local clone copies loose objects directly. Keep automatic maintenance
    // from repacking the fixture concurrently after add or commit returns.
    await execFileAsync('git', ['config', 'maintenance.auto', 'false'], { cwd: source, env });
    for (let offset = 0; offset < count; offset += 128) {
      await Promise.all(Array.from({ length: Math.min(128, count - offset) }, (_, index) => {
        const number = offset + index;
        const content = latePointer && number === count - 1
          ? `version https://git-lfs.github.com/spec/v1\noid sha256:${'d'.repeat(64)}\nsize 12\n`
          : mixed && number % 3 === 0 ? Buffer.from([0, 255, 254, 10, 0])
            : mixed && number % 3 === 1 ? Buffer.alloc(32 * 1024, 120) : `ordinary ${number}\n`;
        return fs.writeFile(path.join(source, `file-${String(number).padStart(5, '0')}.txt`), content);
      }));
    }
    await execFileAsync('git', ['add', '.'], { cwd: source, env });
    await execFileAsync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', 'commit', '-m', 'fixture'], { cwd: source, env });
    const calls = [];
    const service = createNetworkOperations({
      validateGitTransportContext: async () => { throw new Error('clone must not resolve a parent binding'); },
      systemPushAcknowledgements: { isAcknowledged: async () => true, acknowledge: async () => {} },
      credentialResolver: { resolve: async () => { throw new Error('regular clone must not resolve LFS credentials'); } },
      bindClonedRepository: async () => {},
      runtimeIdentity: { id: 'fixture', platform: 'web' },
      inheritedEnv: env,
      spawnImpl: (binary, args, options) => {
        calls.push(args);
        if (args.includes('cat-file')) {
          expect(options.shell).toBe(false);
          expect(options.env).toMatchObject({ GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' });
          expect(args).not.toContain('--filters');
          expect(args).not.toContain('--textconv');
        }
        // Only the fixture transport substitutes the disposable local source for HTTPS.
        return spawn(binary, args.map((arg) => arg === ENDPOINT ? source : arg), options);
      },
    });
    const plan = await service.plan({ operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination, transportMode: 'system', unverifiedConfirmed: true });
    const started = performance.now();
    const result = await service.execute(plan.operationId);
    console.info(JSON.stringify({ scenario: 'lfs-clone-scale', count, mixed, latePointer, state: result.state,
      elapsedMs: Math.round(performance.now() - started), commands: calls.length,
      shows: calls.filter((args) => args.includes('show')).length,
      batches: calls.filter((args) => args.includes('cat-file')).length }));
    if (latePointer) {
      expect(result.state).toBe('partial');
      expect(result.completedSteps).toContain('checked-out');
      expect(['client-missing', 'authorization-required']).toContain(result.hydration.status);
      await expect(fs.stat(destination)).resolves.toBeDefined();
    } else {
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ state: 'succeeded', hydration: { status: 'not-needed' } });
      expect((await fs.readdir(destination)).filter((name) => name !== '.git')).toHaveLength(count);
    }
    expect(calls.filter((args) => args.includes('show'))).toHaveLength(0);
    expect(calls.length).toBeLessThanOrEqual(3 * Math.ceil(count / 128) + 12);
  }, 90_000);

  it.each(['CANCELLED', 'CANCELLED_ACTIVE', 'TIMEOUT', 'overflow'])('stops LFS discovery across batches on %s without publication', async (interruption) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-lfs-interruption-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'checkout');
    const files = Array.from({ length: 257 }, (_, index) => `file-${index}`);
    const content = 'ordinary';
    let metadataBatches = 0;
    let plan;
    if (interruption === 'TIMEOUT') vi.useFakeTimers();
    const operation = setup({
      timeoutMs: 10_000,
      spawnResponder: ({ args }) => {
        if (args.includes('ls-files')) return { stdout: `${files.join('\0')}\0` };
        if (args.includes('check-attr')) return { onSpawn: ({ child }) => {
          const batch = child.stdin.read().toString().slice(0, -1).split('\0');
          child.stdout.write(batch.map((file) => `${file}\0filter\0unspecified\0`).join(''));
        } };
        if (args.includes('--batch-check')) return { onSpawn: ({ child }) => {
          metadataBatches += 1;
          const batch = child.stdin.read().toString().trim().split('\n');
          child.stdout.write(batch.map(() => `${SHA} blob ${content.length}\n`).join(''));
        } };
        if (args.includes('--batch')) return { onSpawn: ({ child }) => {
          const batch = child.stdin.read().toString().trim().split('\n');
          child.stdout.write(batch.map(() => `${SHA} blob ${content.length}\n${content}\n`).join(''));
          if (metadataBatches !== 2) return;
          if (interruption === 'overflow') child.stdout.write(Buffer.alloc(256 * 1024));
          else if (interruption === 'TIMEOUT') vi.setSystemTime(Date.now() + 10_001);
          else if (interruption === 'CANCELLED_ACTIVE') operation.service.cancel(plan.operationId);
          else child.once('close', () => operation.service.cancel(plan.operationId));
        } };
        return { code: 0 };
      },
    });
    plan = await operation.service.plan({ operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination, transportMode: 'system', unverifiedConfirmed: true });
    const result = await operation.service.execute(plan.operationId);
    expect(result).toMatchObject(interruption === 'overflow'
      ? { state: 'partial', hydration: { status: 'invalid' } }
      : { state: 'cancelled', error: { code: interruption.startsWith('CANCELLED') ? 'CANCELLED' : interruption }, hydration: { status: 'cancelled' } });
    expect(metadataBatches).toBe(2);
    expect(operation.calls.filter((call) => call.args.includes('cat-file'))).toHaveLength(4);
    expect(operation.calls.some((call) => call.args.includes('lfs'))).toBe(false);
    if (interruption === 'overflow' || interruption === 'CANCELLED_ACTIVE') {
      expect(operation.children.at(-1).kill).toHaveBeenCalled();
    }
    if (interruption === 'overflow') await expect(fs.stat(destination)).resolves.toBeDefined();
    else await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses a separate HTTPS grant for LFS when the Git parent uses SSH', async () => {
    const lfsEndpoint = 'https://media.example.net/owner/repository.git/info/lfs';
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'e'.repeat(64)}\nsize 12\n`;
    const validateGitAuxiliaryContext = vi.fn(async ({ kind, rawEndpoint }) => ({
      endpoint: rawEndpoint,
      endpointFingerprint: fingerprintRemoteUrl(rawEndpoint),
      transportMode: 'managed',
      credentialId: kind === 'lfs' ? 'lfs-https-credential' : 'unexpected-credential',
      transportRevision: 'transport_one',
    }));
    const setupValue = setup({
      transport: 'ssh',
      validateGitAuxiliaryContext,
      spawnResponder: ({ args }) => {
        const command = args.join(' ');
        if (command.includes('config --blob HEAD:.gitmodules')) return { code: 1 };
        if (command.includes('ls-tree -rz')) return { code: 0 };
        if (command.includes('ls-files -z')) return { code: 0, stdout: 'asset.bin\0' };
        if (command.includes('check-attr')) return { code: 0, stdout: 'asset.bin\0filter\0lfs\0' };
        if (command.includes('cat-file --batch-check')) return { code: 0, stdout: `${SHA} blob ${Buffer.byteLength(pointer)}\n` };
        if (command.includes('cat-file --batch')) return { code: 0, stdout: `${SHA} blob ${Buffer.byteLength(pointer)}\n${pointer}\n` };
        if (command.includes('HEAD:.lfsconfig')) return { code: 0, stdout: `lfs.url\n${lfsEndpoint}\0` };
        if (command.includes('config --includes')) return { code: 1 };
        if (command.includes('lfs version')) return { code: 0, stdout: 'git-lfs/3.0' };
        return { code: 0 };
      },
    });
    setupValue.credentialResolver.resolve.mockImplementation(async ({ mode: requestedMode, credentialId }) => {
      if (requestedMode === 'system') return { mode: 'system' };
      if (credentialId !== 'lfs-https-credential') throw new Error('parent credential must not be reused');
      return {
        mode: 'managed', transport: 'https', username: 'oauth2', password: 'lfs-secret',
        actor: { provider: 'gitlab', instance: 'https://media.example.net', accountId: 'lfs-account', login: null },
        allowedEndpoint: { protocol: 'https', host: 'media.example.net', port: 443, path: 'owner/repository.git/info/lfs' },
      };
    });

    const result = await setupValue.service.hydrateBoundCheckout({
      directory: '/repository', parentRemoteName: 'origin',
      repositoryAuthority: { repositoryId: 'repo_one', bindingRevision: 2, configRevision: 'config_one' },
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      lfs: [{ path: '.', status: 'succeeded', endpoint: { displayUrl: lfsEndpoint } }],
    });
    expect(validateGitAuxiliaryContext).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'lfs', rawEndpoint: lfsEndpoint,
    }));
    expect(setupValue.credentialResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: 'lfs-https-credential',
      endpoint: { protocol: 'https', host: 'media.example.net', port: 443, path: 'owner/repository.git/info/lfs' },
    }));
    expect(setupValue.credentialBroker.issue).toHaveBeenCalledWith(expect.objectContaining({
      endpointAliases: [{ protocol: 'https', host: 'media.example.net', port: 443, path: 'owner/repository.git' }],
    }));
    const lfsFetch = setupValue.calls.find((call) => call.args.includes('lfs') && call.args.includes('fetch'));
    expect(lfsFetch.args).toEqual(expect.arrayContaining([`lfs.url=${lfsEndpoint}`, 'origin', 'HEAD']));
    expect(lfsFetch.options.env.OPENCHAMBER_GIT_SSH_KEY).toBeUndefined();
  });

  it('rejects an effective transport config change between planning and execution before spawning', async () => {
    const setupValue = setup();
    const plan = await setupValue.service.plan(request('fetch'));
    setupValue.validateGitTransportContext.mockResolvedValueOnce({
      ...setupValue.authority,
      transportRevision: 'transport_changed',
    });

    const result = await setupValue.service.execute(plan.operationId);
    expect(result).toMatchObject({
      state: 'conflicted', error: { code: 'REMOTE_CHANGED', message: 'Git remote or transport binding changed' },
    });
    expect(JSON.stringify(result)).not.toContain('transport_changed');
    expect(setupValue.calls).toHaveLength(0);
  });

  it('joins duplicate execute calls and reports an interrupted push as outcome unknown', async () => {
    const setupValue = setup({ spawnResults: [{ manual: true }] });
    const plan = await setupValue.service.plan(request());
    const first = setupValue.service.execute(plan.operationId);
    const second = setupValue.service.execute(plan.operationId);
    expect(second).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setupValue.calls).toHaveLength(2);
    expect(setupValue.service.cancel(plan.operationId).state).toBe('running');
    await expect(first).resolves.toMatchObject({ state: 'outcome-unknown', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(setupValue.calls.find((call) => call.args.includes('push')).child.kill).toHaveBeenCalled();
    expect(setupValue.credentialBroker.revoke).toHaveBeenCalledWith(plan.operationId);
  });

  it('reports a push cancelled before child attachment as cancelled', async () => {
    const setupValue = setup({ spawnResults: [{ manual: true }] });
    const plan = await setupValue.service.plan(request());
    const running = setupValue.service.execute(plan.operationId);
    setupValue.service.cancel(plan.operationId);

    await expect(running).resolves.toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED' } });
    expect(setupValue.calls).toHaveLength(0);
  });

  it('reports a confirmed fetch timeout as cancelled with TIMEOUT', async () => {
    const setupValue = setup({ spawnResults: [{ manual: true }], timeoutMs: 1 });
    const plan = await setupValue.service.plan(request('fetch'));
    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
      state: 'cancelled', error: { code: 'TIMEOUT' },
    });
  });

  it('applies the operation deadline while authority validation is pending', async () => {
    let releaseAuthority;
    const authorityPending = new Promise((resolve) => { releaseAuthority = resolve; });
    const setupValue = setup({ timeoutMs: 5 });
    const plan = await setupValue.service.plan(request('fetch'));
    setupValue.validateGitTransportContext.mockImplementationOnce(() => authorityPending);

    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
      state: 'cancelled', error: { code: 'TIMEOUT' },
    });
    releaseAuthority(setupValue.authority);
    await Promise.resolve();
    expect(setupValue.service.get(plan.operationId)).toMatchObject({ state: 'cancelled', error: { code: 'TIMEOUT' } });
    expect(setupValue.calls).toHaveLength(0);
  });

  it('preserves credential resolver timeout and cancellation markers', async () => {
    for (const marker of [
      { code: 'TIMEOUT', timedOut: true },
      { code: 'CANCELLED', cancelled: true },
    ]) {
      const setupValue = setup();
      const plan = await setupValue.service.plan(request('fetch'));
      setupValue.credentialResolver.resolve.mockRejectedValueOnce(Object.assign(new Error('private resolver failure'), marker));

      await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
        state: 'cancelled', error: { code: marker.code },
      });
      expect(setupValue.calls).toHaveLength(0);
    }
  });

  it('cancels while credential resolution is pending without late registry mutation', async () => {
    let releaseCredential;
    const credentialPending = new Promise((resolve) => { releaseCredential = resolve; });
    const setupValue = setup();
    const plan = await setupValue.service.plan(request('fetch'));
    setupValue.credentialResolver.resolve.mockImplementationOnce(() => credentialPending);
    const running = setupValue.service.execute(plan.operationId);
    await vi.waitFor(() => expect(setupValue.credentialResolver.resolve).toHaveBeenCalled());
    setupValue.service.cancel(plan.operationId);

    await expect(running).resolves.toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED' } });
    releaseCredential({ mode: 'managed', transport: 'https' });
    await Promise.resolve();
    expect(setupValue.service.get(plan.operationId)).toMatchObject({ state: 'cancelled' });
  });

  it('shares one deadline across pull fetch and merge', async () => {
    vi.useFakeTimers();
    try {
      const setupValue = setup({
        spawnResults: [
          { code: 0, onSpawn: () => new Promise((resolve) => setTimeout(resolve, 20)) },
          { manual: true },
          { code: 0 },
        ],
        timeoutMs: 25,
        inspectMergeState: vi.fn(async () => false),
      });
      const plan = await setupValue.service.plan(request('pull'));
      const running = setupValue.service.execute(plan.operationId);
      await vi.advanceTimersByTimeAsync(20);
      expect(setupValue.calls.some((call) => call.args.includes('merge'))).toBe(true);
      await vi.advanceTimersByTimeAsync(5);
      await expect(running).resolves.toMatchObject({ state: 'outcome-unknown' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a fresh deadline to delete a pull ref after the operation deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const setupValue = setup({
        spawnResults: [
          { code: 0, onSpawn: () => vi.setSystemTime(Date.now() + 25) },
          { code: 0 },
        ],
        timeoutMs: 25,
      });
      const plan = await setupValue.service.plan(request('pull'));

      await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
        state: 'cancelled', error: { code: 'TIMEOUT' },
      });
      expect(setupValue.calls[1].args.slice(-3)).toEqual([
        'update-ref', '-d', 'refs/openchamber/network/git_operation_one',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fetches an exact pull refspec before non-interactive local integration', async () => {
    const setupValue = setup({ spawnResults: [{ code: 0 }, { code: 0 }, { code: 0 }] });
    const plan = await setupValue.service.plan(request('pull'));
    const result = await setupValue.service.execute(plan.operationId);
    expect(result).toMatchObject({
      state: 'succeeded',
      completedSteps: ['validated', 'authenticated', 'transferred', 'updated-local-repository'],
    });
    expect(setupValue.calls[0].args.slice(-6)).toEqual([
      'fetch', '--no-tags', '--no-recurse-submodules', '--', ENDPOINT, 'refs/heads/feature:refs/openchamber/network/git_operation_one',
    ]);
    expect(setupValue.calls.find((call) => call.args.includes('merge')).args.slice(-4)).toEqual(['merge', '--no-edit', '--no-verify', SHA]);
    expect(setupValue.calls.at(-1).args.slice(-3)).toEqual(['update-ref', '-d', 'refs/openchamber/network/git_operation_one']);
  });

  it('syncs by fetching and pushing only the two exact targets', async () => {
    const setupValue = setup({ spawnResults: [{ code: 0 }, { code: 0 }, { code: 0 }] });
    const fetchEndpoint = 'https://example.com/upstream/repository.git';
    const pushEndpoint = 'https://example.com/origin/repository.git';
    setupValue.validateGitTransportContext.mockImplementation(async ({ endpointKind }) => ({
      ...setupValue.authority,
      endpoint: endpointKind === 'fetch' ? fetchEndpoint : pushEndpoint,
      endpointFingerprint: fingerprintRemoteUrl(endpointKind === 'fetch' ? fetchEndpoint : pushEndpoint),
    }));
    const input = syncRequest();
    input.fetch.remote.endpoint = {
      displayUrl: fetchEndpoint,
      fingerprint: fingerprintRemoteUrl(fetchEndpoint),
    };
    input.push.remote.endpoint = {
      displayUrl: pushEndpoint,
      fingerprint: fingerprintRemoteUrl(pushEndpoint),
    };
    const plan = await setupValue.service.plan(input);
    const result = await setupValue.service.execute(plan.operationId);

    expect(result).toMatchObject({
      state: 'succeeded',
      stepResults: [
        { step: 'fetch', status: 'succeeded' },
        { step: 'pull', status: 'succeeded' },
        { step: 'push', status: 'succeeded' },
      ],
    });
    expect(setupValue.validateGitTransportContext.mock.calls.map(([value]) => [value.remote, value.endpointKind]))
      .toEqual(expect.arrayContaining([['upstream', 'fetch'], ['origin', 'push']]));
    expect(setupValue.calls[0].args.slice(-6)).toEqual([
      'fetch', '--no-tags', '--no-recurse-submodules', '--', fetchEndpoint, 'refs/heads/main:refs/remotes/upstream/main',
    ]);
    expect(setupValue.calls.find((call) => call.args.includes('merge')).args.slice(-4)).toEqual(['merge', '--no-edit', '--no-verify', SHA]);
    expect(setupValue.calls.at(-1).args.slice(-4)).toEqual(['push', '--', pushEndpoint, `${SHA}:refs/heads/published`]);
  });

  it('returns truthful partial steps when sync push fails', async () => {
    const setupValue = setup({
      spawnResults: [{ code: 0 }, { code: 0 }, { code: 1, stderr: 'remote rejected update' }],
    });
    const plan = await setupValue.service.plan(syncRequest());

    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
      state: 'partial',
      error: { code: 'TRANSPORT_FAILED' },
      stepResults: [
        { step: 'fetch', status: 'succeeded' },
        { step: 'pull', status: 'succeeded' },
        { step: 'push', status: 'failed' },
      ],
    });
  });

  it.each(['granted', 'missing', 'timeout'])('keeps sync LFS hydration behind its own grant: %s', async (grant) => {
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'d'.repeat(64)}\nsize 12\n`;
    const lfsEndpoint = `${ENDPOINT}/info/lfs`;
    if (grant === 'timeout') vi.useFakeTimers();
    const operation = setup({
      timeoutMs: 1_000,
      validateGitAuxiliaryContext: vi.fn(async ({ rawEndpoint }) => {
        expect(rawEndpoint).toBe(lfsEndpoint);
        if (grant !== 'granted') throw Object.assign(new Error('Missing grant'), { code: 'GIT_AUXILIARY_AUTHORIZATION_REQUIRED' });
        return { endpoint: rawEndpoint, endpointFingerprint: fingerprintRemoteUrl(rawEndpoint),
          transportMode: 'managed', credentialId: 'lfs-only', transportRevision: 'lfs' };
      }),
      spawnResponder: ({ args }) => {
        if (args.includes('ls-files')) return { stdout: 'asset.bin\0' };
        if (args.includes('check-attr')) return { stdout: 'asset.bin\0filter\0lfs\0' };
        if (args.includes('--batch-check')) return { stdout: `${SHA} blob ${Buffer.byteLength(pointer)}\n` };
        if (args.includes('--batch')) return { stdout: `${SHA} blob ${Buffer.byteLength(pointer)}\n${pointer}\n`,
          onSpawn: () => { if (grant === 'timeout') vi.setSystemTime(Date.now() + 1_001); } };
        if (args.includes('lfs') && args.includes('version')) return { stdout: 'git-lfs/3.0' };
        return { code: 0 };
      },
    });
    const planned = await operation.service.plan(syncRequest());
    const result = await operation.service.execute(planned.operationId);
    expect(result.completedSteps).toContain('updated-local-repository');
    if (grant === 'granted') {
      expect(result).toMatchObject({ state: 'succeeded', hydration: { status: 'succeeded' } });
      expect(operation.credentialResolver.resolve.mock.calls.map(([input]) => input.credentialId))
        .toEqual(['opaque-credential', 'lfs-only', 'opaque-credential']);
      expect(operation.calls.filter((call) => call.args.includes('lfs') && call.args.includes('fetch'))).toHaveLength(1);
      expect(result.transport).not.toHaveProperty('actor');
      expect(result.transport.fetch).toHaveProperty('actor');
      expect(result.transport.push).toHaveProperty('actor');
    } else {
      expect(result).toMatchObject({ state: grant === 'timeout' ? 'cancelled' : 'partial',
        error: { code: grant === 'timeout' ? 'TIMEOUT' : 'AUTHENTICATION_REQUIRED' },
        stepResults: [{ step: 'fetch', status: 'succeeded' },
          { step: 'pull', status: grant === 'timeout' ? 'cancelled' : 'failed' }, { step: 'push', status: 'skipped' }],
      });
      expect(operation.credentialResolver.resolve).toHaveBeenCalledOnce();
      expect(operation.calls.some((call) => call.args.includes('push'))).toBe(false);
      expect(operation.calls.some((call) => call.args.includes('lfs') && call.args.includes('fetch'))).toBe(false);
    }
    expect(operation.credentialBroker.revoke).toHaveBeenCalledWith(planned.operationId);
  });

  it('fails closed when local filter discovery is truncated or fails, before merge', async () => {
    for (const response of [{ code: 128 }, { stdout: 'filter.custom.process' }, { stdout: 'filter.custom.process\0'.repeat(4_000) }]) {
      const operation = setup({ spawnResponder: ({ args }) => args.includes('--name-only') ? response : { code: 0 } });
      const planned = await operation.service.plan(syncRequest());
      const result = await operation.service.execute(planned.operationId);
      expect(['conflicted', 'partial']).toContain(result.state);
      expect(result.stepResults[0]).toEqual({ step: 'fetch', status: 'succeeded' });
      expect(result.stepResults[2]).toEqual({ step: 'push', status: 'skipped' });
      expect(operation.calls.some((call) => call.args.includes('merge'))).toBe(false);
    }
  });

  it('stops sync after a pull conflict and skips push', async () => {
    const setupValue = setup({ spawnResults: [
      { code: 0 },
      { code: 1, stderr: 'CONFLICT (content): merge conflict' },
    ] });
    const plan = await setupValue.service.plan(syncRequest());

    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
      state: 'conflicted',
      stepResults: [
        { step: 'fetch', status: 'succeeded' },
        { step: 'pull', status: 'conflicted' },
        { step: 'push', status: 'skipped' },
      ],
    });
    expect(setupValue.calls).toHaveLength(3);
  });

  it('honors cancellation between sync steps without starting the next process', async () => {
    const setupValue = setup({ spawnResults: [{ code: 0 }] });
    setupValue.credentialBroker.issue.mockImplementationOnce(() => ({
      gitConfigArgs: ['-c', 'credential.helper=!broker nonce'],
      revoke: () => {
        setupValue.service.cancel('git_operation_one');
        return true;
      },
    }));
    const plan = await setupValue.service.plan(syncRequest());

    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
      state: 'cancelled',
      stepResults: [
        { step: 'fetch', status: 'succeeded' },
        { step: 'pull', status: 'cancelled' },
        { step: 'push', status: 'skipped' },
      ],
    });
    expect(setupValue.calls).toHaveLength(1);
  });

  it('rejects a changed pull HEAD before fetch', async () => {
    const setupValue = setup();
    const plan = await setupValue.service.plan(request('pull'));
    setupValue.resolveSymbolicRef.mockResolvedValueOnce('refs/heads/other');

    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
      state: 'conflicted', error: { code: 'STALE_CONFIG' },
    });
    expect(setupValue.calls).toHaveLength(0);
  });

  it('reports interrupted pull integration as conflicted when MERGE_HEAD exists', async () => {
    const setupValue = setup({
      spawnResults: [{ code: 0 }, { manual: true }, { code: 0 }],
      inspectMergeState: vi.fn(async () => true),
    });
    const plan = await setupValue.service.plan(request('pull'));
    const running = setupValue.service.execute(plan.operationId);
    await vi.waitFor(() => expect(setupValue.calls.some((call) => call.args.includes('merge'))).toBe(true));
    setupValue.service.cancel(plan.operationId);

    await expect(running).resolves.toMatchObject({ state: 'conflicted', error: { code: 'CONFLICT' } });
  });

  it('reports an interrupted pull integration without merge state as outcome unknown', async () => {
    const setupValue = setup({
      spawnResults: [{ code: 0 }, { manual: true }, { code: 0 }],
      inspectMergeState: vi.fn(async () => false),
    });
    const plan = await setupValue.service.plan(request('pull'));
    const running = setupValue.service.execute(plan.operationId);
    await vi.waitFor(() => expect(setupValue.calls.some((call) => call.args.includes('merge'))).toBe(true));
    setupValue.service.cancel(plan.operationId);

    await expect(running).resolves.toMatchObject({ state: 'outcome-unknown', error: { code: 'OUTCOME_UNKNOWN' } });
  });

  it('maps a force-with-lease rejection to a deterministic conflict', async () => {
    const setupValue = setup({ spawnResults: [{ code: 1, stderr: 'rejected stale info force-with-lease' }] });
    const plan = await setupValue.service.plan(request('push', {
      forceWithLease: { expectedRemoteSha: 'b'.repeat(40) },
    }));
    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
      state: 'conflicted', error: { code: 'CONFLICT' },
    });
  });

  it('terminates the Unix process group when cancelling', async () => {
    const setupValue = setup({ spawnResults: [{ manual: true }] });
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      const child = setupValue.children.find((candidate) => -candidate.pid === pid);
      if (child) queueMicrotask(() => {
        child.exitCode = null;
        child.emit('close', null, signal);
      });
      return true;
    });
    try {
      const plan = await setupValue.service.plan(request('fetch'));
      const running = setupValue.service.execute(plan.operationId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      setupValue.service.cancel(plan.operationId);
      await expect(running).resolves.toMatchObject({ state: 'cancelled' });
      expect(kill).toHaveBeenCalledWith(-setupValue.children[0].pid, 'SIGTERM');
    } finally {
      kill.mockRestore();
    }
  });

  it('cleans only its clone temporary directory and never removes an existing destination', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const failed = setup({ spawnResults: [{ code: 1, stderr: 'clone failed' }] });
    const plan = await failed.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });
    await expect(failed.service.execute(plan.operationId)).resolves.toMatchObject({
      state: 'failed', completedSteps: expect.arrayContaining(['cleaned-up']),
    });
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(parent, '.repository.openchamber-git_operation_one.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, 'user-data'), 'keep');
    const existing = setup();
    await expect(existing.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination, transportMode: 'system', unverifiedConfirmed: true,
    })).rejects.toThrow('already exists');
    await expect(fs.readFile(path.join(destination, 'user-data'), 'utf8')).resolves.toBe('keep');
    expect(existing.calls).toHaveLength(0);
  });

  it('applies optional commit identity before publishing a successful clone', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-success-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    const applyGitIdentity = vi.fn(async () => {});
    const setupValue = setup({
      spawnResults: [{ code: 0, onSpawn: () => fs.writeFile(path.join(temporary, 'cloned'), 'yes') }],
      applyGitIdentity,
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT, gitIdentityId: 'identity_one',
    });
    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
      state: 'succeeded', completedSteps: expect.arrayContaining(['checked-out']),
    });
    await expect(fs.readFile(path.join(destination, 'cloned'), 'utf8')).resolves.toBe('yes');
    expect(applyGitIdentity).toHaveBeenCalledWith(temporary, 'identity_one');
  });

  it.each(['system', 'managed', 'anonymous'])('persists the exact %s clone transport at revision one without a provider binding', async (mode) => {
    const fixture = await createLocalRepository();
    await fixture.git('remote', 'add', 'origin', ENDPOINT);
    const destination = path.join(fixture.parent, 'checkout');
    const temporary = path.join(fixture.parent, '.checkout.openchamber-git_operation_one.tmp');
    const filePath = path.join(fixture.parent, 'bindings.json');
    const binding = createBindingService({ store: createBindingStore({ filePath }), resolveRepository: resolveRepositoryIdentity });
    const operation = setup({
      bindClonedRepository: binding.bindClonedRepository,
      spawnResults: [{ code: 0, onSpawn: () => fs.cp(fixture.directory, temporary, { recursive: true }) }],
    });
    const intent = { operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination, transportMode: mode };
    if (mode === 'system') intent.unverifiedConfirmed = true;
    if (mode === 'managed') intent.credentialAccount = CLONE_ACCOUNT;
    const plan = await operation.service.plan(intent);
    const result = await operation.service.execute(plan.operationId);
    expect(result).toMatchObject({ state: 'succeeded', completedSteps: expect.arrayContaining(['checked-out', 'updated-local-repository']) });
    const saved = await binding.get(destination);
    expect(saved).toMatchObject({ revision: 1, binding: { revision: 1, state: 'bound', providers: [], auxiliary: [],
      remotes: [{ name: 'origin', mode, readiness: 'ready', fetch: { fingerprint: fingerprintRemoteUrl(ENDPOINT) },
        push: { fingerprint: fingerprintRemoteUrl(ENDPOINT) } }],
    } });
    if (mode === 'managed') {
      const credentialId = createHttpsCredentialReference({
        provider: CLONE_ACCOUNT.provider,
        instance: CLONE_ACCOUNT.instance,
        credentialId: CLONE_CREDENTIAL.credentialId,
        credentialRevision: CLONE_CREDENTIAL.credentialRevision,
        providerUserId: CLONE_CREDENTIAL.providerUserId,
      });
      expect(saved.binding.remotes[0].credentialId).toBe(credentialId);
      expect(operation.credentialResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ credentialId }));
      expect(JSON.stringify(result)).not.toContain(credentialId);
    } else {
      expect(saved.binding.remotes[0]).not.toHaveProperty('credentialId');
      expect(operation.credentialResolver.resolve).not.toHaveBeenCalled();
    }
    expect(await fs.readFile(filePath, 'utf8')).not.toContain('top-secret');
    await expect(operation.service.plan(intent)).rejects.toThrow('already exists');
    expect(operation.calls.filter((call) => call.args.includes('clone'))).toHaveLength(1);
  });

  it.each(['success', 'fetch', 'push', 'write'])('preserves managed SSH clone binding and retained-checkout handling for %s', async (outcome) => {
    const fixture = await createLocalRepository();
    const remoteUrl = 'git@example.com:owner/repository.git';
    await fixture.git('remote', 'add', 'origin', outcome === 'fetch' ? 'git@example.com:other.git' : remoteUrl);
    if (outcome === 'push') await fixture.git('remote', 'set-url', '--push', 'origin', 'git@example.com:other.git');
    const destination = path.join(fixture.parent, 'checkout');
    const temporary = path.join(fixture.parent, '.checkout.openchamber-git_operation_one.tmp');
    const binding = createBindingService({ resolveRepository: resolveRepositoryIdentity,
      store: createBindingStore({ filePath: path.join(fixture.parent, 'ssh-bindings.json'), fsImpl: { ...fs,
        writeFile: async (...args) => {
          if (outcome === 'write') throw new Error('private-write-error');
          return fs.writeFile(...args);
        },
      } }),
    });
    const sshCredentialId = createSshCredentialReference('selected_host_key');
    const validateManagedSshCredential = vi.fn(async () => {});
    const operation = setup({ transport: 'ssh', validateManagedSshCredential,
      bindClonedRepository: binding.bindClonedRepository,
      spawnResults: [{ code: 0, onSpawn: () => fs.cp(fixture.directory, temporary, { recursive: true }) }],
    });
    const plan = await operation.service.plan({ operation: 'clone', remoteUrl, destinationPath: destination,
      transportMode: 'managed', sshCredentialId });
    expect(validateManagedSshCredential).toHaveBeenCalledExactlyOnceWith(sshCredentialId);
    const result = await operation.service.execute(plan.operationId);
    expect(result).toMatchObject({ state: outcome === 'success' ? 'succeeded' : 'partial',
      completedSteps: expect.arrayContaining(['checked-out', 'cleaned-up']) });
    expect(operation.credentialResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ credentialId: sshCredentialId }));
    expect(operation.credentialBroker.issue).not.toHaveBeenCalled();
    expect(result.transport.actor).toEqual({ kind: 'ssh-key', fingerprint: `SHA256:${'a'.repeat(43)}` });
    for (const privateValue of [sshCredentialId, '/keys/', fixture.parent, 'private-write-error']) expect(JSON.stringify(result)).not.toContain(privateValue);
    await expect(fs.readFile(path.join(destination, 'README.md'), 'utf8')).resolves.toBe('ordinary content\n');
    await expect(fs.stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    const saved = await binding.get(destination);
    if (outcome === 'success') expect(saved).toMatchObject({ revision: 1, binding: { providers: [], auxiliary: [],
      remotes: [{ mode: 'managed', credentialId: sshCredentialId, fetch: { fingerprint: fingerprintRemoteUrl(remoteUrl) },
        push: { fingerprint: fingerprintRemoteUrl(remoteUrl) } }],
    } });
    else expect(saved).toMatchObject({ revision: 0, binding: null });
  });

  it.each(['managed', 'anonymous'].flatMap((mode) => ['write', 'fetch', 'push'].map((failure) => [mode, failure])))('retains the completed %s clone when binding fails at %s', async (mode, failure) => {
    const fixture = await createLocalRepository();
    await fixture.git('remote', 'add', 'origin', failure === 'fetch' ? 'https://example.com/other.git' : ENDPOINT);
    if (failure === 'push') await fixture.git('remote', 'set-url', '--push', 'origin', 'https://example.com/other.git');
    const destination = path.join(fixture.parent, 'checkout');
    const temporary = path.join(fixture.parent, '.checkout.openchamber-git_operation_one.tmp');
    const filePath = path.join(fixture.parent, 'bindings.json');
    const writeFile = vi.fn(async (...args) => {
      if (failure === 'write') throw new Error('private token and path must never escape');
      return fs.writeFile(...args);
    });
    const store = createBindingStore({ filePath, fsImpl: { ...fs, writeFile } });
    const binding = createBindingService({ store, resolveRepository: resolveRepositoryIdentity });
    const operation = setup({
      bindClonedRepository: binding.bindClonedRepository,
      spawnResults: [{ code: 0, onSpawn: () => fs.cp(fixture.directory, temporary, { recursive: true }) }],
    });
    const intent = { operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination, transportMode: mode };
    if (mode === 'managed') intent.credentialAccount = CLONE_ACCOUNT;
    const plan = await operation.service.plan(intent);
    const result = await operation.service.execute(plan.operationId);
    expect(result).toMatchObject({ state: 'partial', completedSteps: expect.arrayContaining(['checked-out', 'cleaned-up']) });
    expect(result.completedSteps).not.toContain('updated-local-repository');
    expect(result.error.message).toContain('do not clone again');
    expect(JSON.stringify(result)).not.toContain('private token');
    expect(JSON.stringify(result)).not.toContain(fixture.parent);
    await expect(fs.readFile(path.join(destination, 'README.md'), 'utf8')).resolves.toBe('ordinary content\n');
    await expect(fs.stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await binding.get(destination)).toMatchObject({ revision: 0, binding: null });
    if (failure !== 'write') expect(writeFile).not.toHaveBeenCalled();
    await expect(operation.service.plan(intent)).rejects.toThrow('already exists');
    expect(operation.calls.filter((call) => call.args.includes('clone'))).toHaveLength(1);
  });

  it('waits for binding persistence after cancellation and retains the completed checkout on write failure', async () => {
    const fixture = await createLocalRepository();
    await fixture.git('remote', 'add', 'origin', ENDPOINT);
    const destination = path.join(fixture.parent, 'checkout');
    const temporary = path.join(fixture.parent, '.checkout.openchamber-git_operation_one.tmp');
    let failWrite;
    const writePending = new Promise((_resolve, reject) => { failWrite = reject; });
    const writeFile = vi.fn(() => writePending);
    const binding = createBindingService({
      store: createBindingStore({ filePath: path.join(fixture.parent, 'bindings.json'), fsImpl: { ...fs, writeFile } }),
      resolveRepository: resolveRepositoryIdentity,
    });
    const operation = setup({
      bindClonedRepository: binding.bindClonedRepository,
      spawnResults: [{ code: 0, onSpawn: () => fs.cp(fixture.directory, temporary, { recursive: true }) }],
    });
    const plan = await operation.service.plan({ operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'system', unverifiedConfirmed: true });
    const executing = operation.service.execute(plan.operationId);
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce());
    operation.service.cancel(plan.operationId);
    expect(operation.service.get(plan.operationId)).toMatchObject({ state: 'running', completedSteps: expect.arrayContaining(['checked-out']) });
    failWrite(new Error('disk full'));
    expect(await executing).toMatchObject({ state: 'partial' });
    await expect(fs.readFile(path.join(destination, 'README.md'), 'utf8')).resolves.toBe('ordinary content\n');
    expect(await binding.get(destination)).toMatchObject({ revision: 0, binding: null });
  });

  it('retains and binds a checked-out clone whose LFS hydration is incomplete', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-lfs-missing-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'e'.repeat(64)}\nsize 8\n`;
    const setupValue = setup({
      spawnResponder: ({ args }) => {
        const command = args.join(' ');
        if (args.includes('clone')) return { code: 0, onSpawn: () => fs.writeFile(path.join(temporary, 'asset.bin'), pointer) };
        if (command.includes('config --blob HEAD:.gitmodules')) return { code: 1 };
        if (command.includes('ls-tree -rz')) return { code: 0 };
        if (command.includes('ls-files -z')) return { code: 0, stdout: 'asset.bin\0' };
        if (command.includes('check-attr')) return { code: 0, stdout: 'asset.bin\0filter\0lfs\0' };
        if (command.includes('cat-file --batch-check')) return { code: 0, stdout: `${SHA} blob ${Buffer.byteLength(pointer)}\n` };
        if (command.includes('cat-file --batch')) return { code: 0, stdout: `${SHA} blob ${Buffer.byteLength(pointer)}\n${pointer}\n` };
        if (command.includes('HEAD:.lfsconfig') || command.includes('config --includes')) return { code: 1 };
        if (command.includes('lfs version')) return { code: 1 };
        return { code: 0 };
      },
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });

    const result = await setupValue.service.execute(plan.operationId);

    expect(result).toMatchObject({
      state: 'partial', error: { code: 'GIT_LFS_CLIENT_MISSING' },
      hydration: { status: 'client-missing' },
      completedSteps: expect.arrayContaining(['checked-out', 'updated-local-repository']),
    });
    await expect(fs.readFile(path.join(destination, 'asset.bin'), 'utf8')).resolves.toBe(pointer);
    await expect(fs.stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops before the next submodule when cancellation arrives between children', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-cancel-children-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    const alphaEndpoint = 'https://example.com/owner/alpha.git';
    const betaEndpoint = 'https://example.com/owner/beta.git';
    const manifest = [
      'submodule.alpha.path\nvendor/alpha\0', 'submodule.alpha.url\n../alpha.git\0',
      'submodule.beta.path\nvendor/beta\0', 'submodule.beta.url\n../beta.git\0',
    ].join('');
    let plan;
    let setupValue;
    setupValue = setup({
      spawnResponder: ({ args, options }) => {
        const command = args.join(' ');
        if (args.includes('clone') && args.includes(ENDPOINT)) {
          return { code: 0, onSpawn: () => fs.writeFile(path.join(temporary, 'README.md'), 'checkout') };
        }
        if (command.includes('config --blob HEAD:.gitmodules')) {
          return options.cwd === temporary ? { code: 0, stdout: manifest } : { code: 1 };
        }
        if (command.includes('ls-tree -rz')) return options.cwd === temporary ? {
          code: 0,
          stdout: `160000 commit ${'b'.repeat(40)}\tvendor/alpha\0` + `160000 commit ${'c'.repeat(40)}\tvendor/beta\0`,
        } : { code: 0 };
        if (command.includes('rev-parse --verify HEAD') && options.cwd.endsWith('vendor/alpha')) {
          return { code: 0, stdout: 'b'.repeat(40) };
        }
        if (command.includes('ls-files -z') && options.cwd.endsWith('vendor/alpha')) {
          return { code: 0, onSpawn: () => setupValue.service.cancel(plan.operationId) };
        }
        if (command.includes('ls-files -z')) return { code: 0 };
        if (command.includes('HEAD:.lfsconfig') || command.includes('config --includes')) return { code: 1 };
        if (command.includes('lfs version')) return { code: 1 };
        return { code: 0 };
      },
    });
    plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
      auxiliaryGrants: [alphaEndpoint, betaEndpoint].map((endpoint) => ({
        kind: 'submodule', transportMode: 'system', unverifiedConfirmed: true,
        endpoint: { displayUrl: endpoint, fingerprint: fingerprintRemoteUrl(endpoint) },
      })),
    });

    const result = await setupValue.service.execute(plan.operationId);

    expect(result).toMatchObject({
      state: 'cancelled',
      hydration: { submodules: [{ path: 'vendor/alpha', status: 'succeeded' }] },
    });
    const childCloneEndpoints = setupValue.calls
      .filter((call) => call.args.includes('clone') && !call.args.includes(ENDPOINT))
      .flatMap((call) => call.args.filter((arg) => arg.startsWith('https://')));
    expect(childCloneEndpoints).toEqual([alphaEndpoint]);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates legacy clone identity before spawning and uses system transport', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-legacy-clone-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const validateGitIdentity = vi.fn(async () => {});
    const setupValue = setup({
      mode: 'system',
      validateGitIdentity,
      applyGitIdentity: vi.fn(async () => {}),
    });

    const result = await setupValue.service.cloneRepository({
      unverifiedConfirmed: true,
      remoteUrl: ENDPOINT,
      destinationPath: destination,
      gitIdentityId: 'identity_one',
    });

    expect(result).toMatchObject({ state: 'succeeded', output: '' });
    expect(validateGitIdentity).toHaveBeenCalledWith('identity_one');
    expect(setupValue.calls[0].args).toEqual([
      'clone', '--no-checkout', '--', ENDPOINT, path.join(parent, '.repository.openchamber-git_operation_one.tmp'),
    ]);
    expect(setupValue.credentialBroker.start).not.toHaveBeenCalled();
  });

  it('rejects an invalid legacy clone identity before planning or spawning', async () => {
    const setupValue = setup({
      mode: 'system',
      validateGitIdentity: vi.fn(async () => { throw new Error('missing'); }),
    });

    await expect(setupValue.service.cloneRepository({
      unverifiedConfirmed: true,
      remoteUrl: ENDPOINT,
      destinationPath: '/new/repository',
      gitIdentityId: 'missing',
    })).rejects.toMatchObject({ code: 'INVALID_GIT_IDENTITY', status: 400 });
    expect(setupValue.calls).toHaveLength(0);
  });

  it('preserves the deadline marker when legacy identity validation hangs', async () => {
    const setupValue = setup({
      mode: 'system',
      timeoutMs: 5,
      validateGitIdentity: vi.fn(() => new Promise(() => {})),
    });

    await expect(setupValue.service.cloneRepository({
      remoteUrl: ENDPOINT,
      destinationPath: '/new/repository',
      gitIdentityId: 'identity_one',
      unverifiedConfirmed: true,
    })).rejects.toMatchObject({ code: 'TIMEOUT', timedOut: true });
    expect(setupValue.calls).toHaveLength(0);
  });

  it('applies the planning deadline to clone filesystem reads', async () => {
    const fsImpl = { ...fs, stat: vi.fn(() => new Promise(() => {})) };
    const setupValue = setup({ fsImpl, timeoutMs: 5 });

    await expect(setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: '/new/repository', transportMode: 'system', unverifiedConfirmed: true,
    })).rejects.toMatchObject({ code: 'TIMEOUT', timedOut: true });
    expect(setupValue.calls).toHaveLength(0);
  });

  it('removes only the temporary checkout when identity configuration fails', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-identity-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    const setupValue = setup({
      spawnResults: [{ code: 0, onSpawn: () => fs.writeFile(path.join(temporary, 'cloned'), 'yes') }],
      applyGitIdentity: vi.fn(async () => { throw new Error('config failed'); }),
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT, gitIdentityId: 'identity_one',
    });

    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
      state: 'failed', completedSteps: expect.arrayContaining(['transferred', 'cleaned-up']),
    });
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not publish a clone cancelled while identity configuration is pending', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-cancel-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    let releaseIdentity;
    const identityPending = new Promise((resolve) => { releaseIdentity = resolve; });
    const applyGitIdentity = vi.fn(() => identityPending);
    const setupValue = setup({
      spawnResults: [{ code: 0, onSpawn: () => fs.writeFile(path.join(temporary, 'cloned'), 'yes') }],
      applyGitIdentity,
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT, gitIdentityId: 'identity_one',
    });

    const running = setupValue.service.execute(plan.operationId);
    await vi.waitFor(() => expect(applyGitIdentity).toHaveBeenCalledOnce());
    setupValue.service.cancel(plan.operationId);
    releaseIdentity();

    await expect(running).resolves.toMatchObject({
      state: 'cancelled', completedSteps: expect.arrayContaining(['transferred', 'cleaned-up']),
    });
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for a late filesystem mutation before recording timeout and cleaning it up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-fs-timeout-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    let releaseMkdir;
    let markMkdirStarted;
    let mutationSettled = false;
    const delayedMkdir = new Promise((resolve) => { releaseMkdir = resolve; });
    const mkdirStarted = new Promise((resolve) => { markMkdirStarted = resolve; });
    const fsImpl = {
      ...fs,
      mkdir: vi.fn(async (target, options) => {
        if (target === parent && options?.recursive) {
          markMkdirStarted();
          await delayedMkdir;
          mutationSettled = true;
        }
        return fs.mkdir(target, options);
      }),
    };
    const setupValue = setup({ fsImpl, timeoutMs: 5 });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });

    const running = setupValue.service.execute(plan.operationId);
    await mkdirStarted;
    vi.setSystemTime(Date.now() + 10);
    expect(setupValue.service.get(plan.operationId).state).toBe('running');
    releaseMkdir();
    await expect(running).resolves.toMatchObject({
      state: 'cancelled', error: { code: 'TIMEOUT' },
    });
    expect(mutationSettled).toBe(true);
    expect(setupValue.calls).toHaveLength(0);
  });

  it('waits for a late identity mutation before timing out and cleaning the temporary checkout', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-identity-timeout-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    let releaseIdentity;
    const identityPending = new Promise((resolve) => { releaseIdentity = resolve; });
    const applyGitIdentity = vi.fn(() => identityPending);
    const setupValue = setup({
      timeoutMs: 100,
      spawnResults: [{ code: 0, onSpawn: () => fs.writeFile(path.join(temporary, 'cloned'), 'yes') }],
      applyGitIdentity,
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT, gitIdentityId: 'identity_one',
    });

    const running = setupValue.service.execute(plan.operationId);
    await vi.waitFor(() => expect(applyGitIdentity).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(setupValue.service.get(plan.operationId).state).toBe('running');
    releaseIdentity();
    await expect(running).resolves.toMatchObject({
      state: 'cancelled', error: { code: 'TIMEOUT' },
    });
    await expect(fs.stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not replace a destination created while clone is running', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-destination-race-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const setupValue = setup({
      spawnResults: [{
        code: 0,
        onSpawn: async () => {
          await fs.mkdir(destination);
          await fs.writeFile(path.join(destination, 'other-owner'), 'keep');
        },
      }],
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });

    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
      state: 'conflicted', error: { code: 'CONFLICT' },
    });
    await expect(fs.readFile(path.join(destination, 'other-owner'), 'utf8')).resolves.toBe('keep');
  });

  it('never cleans up a replaced temporary directory', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-temp-race-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    const setupValue = setup({
      spawnResults: [{
        code: 0,
        onSpawn: async () => {
          await fs.rm(temporary, { recursive: true });
          await fs.mkdir(temporary);
          await fs.writeFile(path.join(temporary, 'other-owner'), 'keep');
        },
      }],
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });

    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
      state: 'failed', error: { code: 'UNKNOWN', message: 'Clone cleanup failed' },
    });
    await expect(fs.readFile(path.join(temporary, 'other-owner'), 'utf8')).resolves.toBe('keep');
  });

  it('returns a safe failure when owned clone cleanup fails', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-cleanup-failure-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    const fsImpl = {
      ...fs,
      rm: vi.fn(async (target, options) => {
        if (String(target).includes('.openchamber-quarantine-git_operation_one-')) throw new Error(`private cleanup ${target}`);
        return fs.rm(target, options);
      }),
    };
    const setupValue = setup({ spawnResults: [{ code: 1, stderr: 'clone failed' }], fsImpl });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });

    const result = await setupValue.service.execute(plan.operationId);
    expect(result).toMatchObject({ state: 'failed', error: { code: 'UNKNOWN', message: 'Clone cleanup failed' } });
    expect(JSON.stringify(result)).not.toContain(temporary);
  });

  it('never removes a destination pathname replaced during failed publication', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-publication-race-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    let replaced = false;
    const fsImpl = {
      ...fs,
      copyFile: vi.fn(async (source, target, mode) => {
        if (!replaced) {
          replaced = true;
          await fs.rm(destination, { recursive: true });
          await fs.mkdir(destination);
          await fs.writeFile(path.join(destination, 'other-owner'), 'keep');
        }
        return fs.copyFile(source, target, mode);
      }),
    };
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    const setupValue = setup({
      fsImpl,
      spawnResults: [{ code: 0, onSpawn: () => fs.writeFile(path.join(temporary, 'cloned'), 'yes') }],
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });

    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({ state: 'conflicted' });
    await expect(fs.readFile(path.join(destination, 'other-owner'), 'utf8')).resolves.toBe('keep');
  });

  it('preserves concurrently added and replaced entries after a failed checkout copy', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-entry-race-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    const fsImpl = {
      ...fs,
      copyFile: vi.fn(async (source, target, mode) => {
        if (path.basename(target) === 'b-fail') {
          await fs.rm(path.join(destination, 'a-owned'));
          await fs.writeFile(path.join(destination, 'a-owned'), 'user replacement');
          await fs.writeFile(path.join(destination, 'user-added'), 'keep');
          throw new Error('copy failed');
        }
        return fs.copyFile(source, target, mode);
      }),
    };
    const setupValue = setup({
      fsImpl,
      spawnResults: [{
        code: 0,
        onSpawn: async () => {
          await fs.writeFile(path.join(temporary, 'a-owned'), 'clone data');
          await fs.writeFile(path.join(temporary, 'b-fail'), 'clone data');
        },
      }],
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });

    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({ state: 'failed' });
    await expect(fs.readFile(path.join(destination, 'a-owned'), 'utf8')).resolves.toBe('user replacement');
    await expect(fs.readFile(path.join(destination, 'user-added'), 'utf8')).resolves.toBe('keep');
  });

  it('preserves a copied top-level entry modified during a failed checkout copy', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-entry-modified-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    const fsImpl = {
      ...fs,
      copyFile: vi.fn(async (source, target, mode) => {
        if (path.basename(target) === 'b-fail') {
          await fs.writeFile(path.join(destination, 'a-owned'), 'user modified this copied file');
          throw new Error('copy failed');
        }
        return fs.copyFile(source, target, mode);
      }),
    };
    const setupValue = setup({
      fsImpl,
      spawnResults: [{
        code: 0,
        onSpawn: async () => {
          await fs.writeFile(path.join(temporary, 'a-owned'), 'clone data');
          await fs.writeFile(path.join(temporary, 'b-fail'), 'clone data');
        },
      }],
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });

    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({ state: 'failed' });
    await expect(fs.readFile(path.join(destination, 'a-owned'), 'utf8')).resolves.toBe('user modified this copied file');
  });

  it('preserves a nested copied file modified during failed publication', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-nested-modified-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    const fsImpl = {
      ...fs,
      copyFile: vi.fn(async (source, target, mode) => {
        if (path.basename(target) === 'z-fail') {
          await fs.writeFile(path.join(destination, 'a-directory', 'owned'), 'user modified');
          throw new Error('copy failed');
        }
        return fs.copyFile(source, target, mode);
      }),
    };
    const setupValue = setup({
      fsImpl,
      spawnResults: [{ code: 0, onSpawn: async () => {
        await fs.mkdir(path.join(temporary, 'a-directory'));
        await fs.writeFile(path.join(temporary, 'a-directory', 'owned'), 'clone data');
        await fs.writeFile(path.join(temporary, 'z-fail'), 'clone data');
      } }],
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });
    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({ state: 'failed' });
    await expect(fs.readFile(path.join(destination, 'a-directory', 'owned'), 'utf8')).resolves.toBe('user modified');
  });

  it('preserves a concurrently inserted nested file during failed publication', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-nested-inserted-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    const fsImpl = {
      ...fs,
      copyFile: vi.fn(async (source, target, mode) => {
        if (path.basename(target) === 'z-fail') {
          await fs.writeFile(path.join(destination, 'a-directory', 'user-added'), 'keep');
          throw new Error('copy failed');
        }
        return fs.copyFile(source, target, mode);
      }),
    };
    const setupValue = setup({
      fsImpl,
      spawnResults: [{ code: 0, onSpawn: async () => {
        await fs.mkdir(path.join(temporary, 'a-directory'));
        await fs.writeFile(path.join(temporary, 'a-directory', 'owned'), 'clone data');
        await fs.writeFile(path.join(temporary, 'z-fail'), 'clone data');
      } }],
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });
    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({ state: 'failed' });
    await expect(fs.readFile(path.join(destination, 'a-directory', 'user-added'), 'utf8')).resolves.toBe('keep');
    await expect(fs.readFile(path.join(destination, 'a-directory', 'owned'), 'utf8')).resolves.toBe('clone data');
  });

  it('preserves a replaced nested directory node during failed publication', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-nested-replaced-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    const fsImpl = {
      ...fs,
      copyFile: vi.fn(async (source, target, mode) => {
        if (path.basename(target) === 'z-fail') {
          const nested = path.join(destination, 'a-directory');
          await fs.rm(nested, { recursive: true });
          await fs.mkdir(nested);
          await fs.writeFile(path.join(nested, 'replacement'), 'keep');
          throw new Error('copy failed');
        }
        return fs.copyFile(source, target, mode);
      }),
    };
    const setupValue = setup({
      fsImpl,
      spawnResults: [{ code: 0, onSpawn: async () => {
        await fs.mkdir(path.join(temporary, 'a-directory'));
        await fs.writeFile(path.join(temporary, 'a-directory', 'owned'), 'clone data');
        await fs.writeFile(path.join(temporary, 'z-fail'), 'clone data');
      } }],
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });
    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({ state: 'failed' });
    await expect(fs.readFile(path.join(destination, 'a-directory', 'replacement'), 'utf8')).resolves.toBe('keep');
  });

  it('quarantines a destination replacement introduced immediately before cleanup', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-cleanup-rename-race-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    let replaced = false;
    const fsImpl = {
      ...fs,
      copyFile: vi.fn(async (source, target, mode) => {
        if (path.basename(target) === 'z-fail') throw new Error('copy failed');
        return fs.copyFile(source, target, mode);
      }),
      rename: vi.fn(async (source, target) => {
        if (source === destination && !replaced) {
          replaced = true;
          await fs.rm(destination, { recursive: true });
          await fs.mkdir(destination);
          await fs.writeFile(path.join(destination, 'user-replacement'), 'keep');
        }
        return fs.rename(source, target);
      }),
    };
    const setupValue = setup({
      fsImpl,
      spawnResults: [{ code: 0, onSpawn: async () => {
        await fs.writeFile(path.join(temporary, 'a-owned'), 'clone data');
        await fs.writeFile(path.join(temporary, 'z-fail'), 'clone data');
      } }],
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });

    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({ state: 'failed' });
    await expect(fs.readFile(path.join(destination, 'user-replacement'), 'utf8')).resolves.toBe('keep');
    expect((await fs.readdir(parent)).some((name) => name.includes('.openchamber-quarantine-'))).toBe(false);
  });

  it('leaves the complete changed destination in quarantine when atomic restore fails', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-network-clone-cleanup-restore-conflict-'));
    temporaryDirectories.push(parent);
    const destination = path.join(parent, 'repository');
    const temporary = path.join(parent, '.repository.openchamber-git_operation_one.tmp');
    let replaced = false;
    const fsImpl = {
      ...fs,
      cp: vi.fn(async () => { throw new Error('recursive restore must not run'); }),
      copyFile: vi.fn(async (source, target, mode) => {
        if (path.basename(target) === 'z-fail') throw new Error('copy failed');
        return fs.copyFile(source, target, mode);
      }),
      rename: vi.fn(async (source, target) => {
        if (source === destination && !replaced) {
          replaced = true;
          await fs.rm(destination, { recursive: true });
          await fs.mkdir(destination);
          await fs.writeFile(path.join(destination, 'user-replacement'), 'keep');
        }
        if (path.basename(source) === 'object' && target === destination) {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return fs.rename(source, target);
      }),
    };
    const setupValue = setup({
      fsImpl,
      spawnResults: [{ code: 0, onSpawn: async () => {
        await fs.writeFile(path.join(temporary, 'a-owned'), 'clone data');
        await fs.writeFile(path.join(temporary, 'z-fail'), 'clone data');
      } }],
    });
    const plan = await setupValue.service.plan({
      operation: 'clone', remoteUrl: ENDPOINT, destinationPath: destination,
      transportMode: 'managed', credentialAccount: CLONE_ACCOUNT,
    });

    await expect(setupValue.service.execute(plan.operationId)).resolves.toMatchObject({
      state: 'failed', error: { code: 'UNKNOWN', message: 'Clone cleanup failed' },
    });
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    const quarantine = (await fs.readdir(parent)).find((name) => name.includes('.openchamber-quarantine-git_operation_one-'));
    expect(quarantine).toBeTruthy();
    await expect(fs.readFile(path.join(parent, quarantine, 'object', 'user-replacement'), 'utf8')).resolves.toBe('keep');
    expect(fsImpl.cp).not.toHaveBeenCalled();
  });
});
