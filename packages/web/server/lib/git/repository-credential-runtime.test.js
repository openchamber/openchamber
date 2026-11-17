import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitRepositoryCredentialRuntime } from './repository-credential-runtime.js';
import { createHttpsCredentialReference } from './credential-resolver.js';

const GITHUB = 'https://github.com/owner/repo.git';
const endpoint = (displayUrl) => ({ displayUrl, fingerprint: `fp:${displayUrl}` });
const grant = (overrides = {}) => ({
  name: 'origin', mode: 'managed', credentialId: createHttpsCredentialReference({ provider: 'github', instance: 'github.com', credentialId: 'cred', credentialRevision: 1, providerUserId: 'github.com#42' }), readiness: 'ready',
  fetch: endpoint(GITHUB), push: endpoint(GITHUB), ...overrides,
});
const read = (remotes) => ({
  status: remotes ? 'bound' : 'missing', revision: 1,
  repository: { repositoryId: 'repo_one', configRevision: 'c1', remotes: [{ name: 'origin', fetch: endpoint(GITHUB), push: endpoint(GITHUB) }] },
  binding: remotes ? { repositoryId: 'repo_one', revision: 1, providers: [], remotes, auxiliary: [] } : null,
});

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

const setup = async ({ binding = read([grant()]), resolve = async () => ({ transport: 'https', username: 'x-access-token', password: 'secret-value' }), port = 4399 } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-repo-credential-'));
  roots.push(dataDir);
  const resolved = [];
  const runtime = createGitRepositoryCredentialRuntime({
    readBinding: async (directory) => { if (directory === '/not-a-repo') throw new Error('nope'); return binding; },
    credentialResolver: { resolve: async (input) => { resolved.push(input); return resolve(input); } },
    dataDir, fsPromises: fs,
    getActivePort: () => port,
    helperPath: '/opt/openchamber/repository-credential-helper.js',
  });
  return { runtime, dataDir, resolved };
};

const ask = async (runtime, { secret, body, remoteAddress = '127.0.0.1' }) => {
  let handler;
  runtime.registerRoutes({ post: (_path, route) => { handler = route; } });
  let status = 200;
  let answer;
  await handler(
    { socket: { remoteAddress }, headers: { authorization: `Bearer ${secret}` }, body },
    { set: () => {}, status: (code) => { status = code; return { end: () => {} }; }, json: (value) => { answer = value; } },
  );
  return { status, answer };
};

const readEndpoint = async (dataDir) => JSON.parse(await fs.readFile(path.join(dataDir, 'git-credential-endpoint.json'), 'utf8'));

describe('createGitRepositoryCredentialRuntime', () => {
  it('publishes a private endpoint file and a launcher, and names the launcher as the helper', async () => {
    const { runtime, dataDir } = await setup();
    await runtime.publish();
    const published = await readEndpoint(dataDir);
    expect(published).toEqual({ version: 1, url: 'http://127.0.0.1:4399/api/git/repository-credential', secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect((await fs.stat(path.join(dataDir, 'git-credential-endpoint.json'))).mode & 0o777).toBe(0o600);
    const launcher = await fs.readFile(path.join(dataDir, 'bin', 'git-credential-openchamber'), 'utf8');
    expect(launcher).toContain(`'/opt/openchamber/repository-credential-helper.js' '${path.join(dataDir, 'git-credential-endpoint.json')}' "$@"`);
    expect((await fs.stat(path.join(dataDir, 'bin', 'git-credential-openchamber'))).mode & 0o777).toBe(0o700);
    expect(runtime.helperCommand()).toBe(`!'${path.join(dataDir, 'bin', 'git-credential-openchamber')}'`);
  });

  it.skipIf(process.platform === 'win32')('publishes a launcher that runs the helper as Node under Electron', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-repo-credential-'));
    roots.push(dataDir);
    const executable = path.join(dataDir, 'electron');
    await fs.writeFile(executable, '#!/bin/sh\nprintf "%s|%s" "$ELECTRON_RUN_AS_NODE" "$*"\n', { mode: 0o700 });
    const runtime = createGitRepositoryCredentialRuntime({
      readBinding: async () => read(null),
      credentialResolver: { resolve: async () => null },
      dataDir, fsPromises: fs,
      getActivePort: () => 4399,
      helperPath: '/opt/openchamber/repository-credential-helper.js',
      helperLaunch: { execPath: executable, versions: { electron: '1.0.0' } },
    });
    await runtime.publish();

    const launcher = path.join(dataDir, 'bin', 'git-credential-openchamber');
    const output = await new Promise((resolve, reject) => {
      execFile(launcher, ['get'], (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
    expect(output).toBe(`1|/opt/openchamber/repository-credential-helper.js ${path.join(dataDir, 'git-credential-endpoint.json')} get`);
  });

  it('answers the bound account credential for the repository the helper runs in', async () => {
    const { runtime, dataDir, resolved } = await setup();
    await runtime.publish();
    const { secret } = await readEndpoint(dataDir);
    const { answer } = await ask(runtime, { secret, body: { cwd: '/repo', query: 'protocol=https\nhost=github.com\n' } });
    expect(answer).toEqual({ mode: 'managed', username: 'x-access-token', password: 'secret-value' });
    expect(resolved[0]).toMatchObject({ mode: 'managed', endpoint: { protocol: 'https', host: 'github.com', path: '/owner/repo.git' } });
  });

  it('hands System, unbound and unmatched repositories back to the machine, and a lost credential to nobody', async () => {
    const body = { cwd: '/repo', query: 'protocol=https\nhost=github.com\n' };
    for (const [binding, mode] of [
      [read([grant({ mode: 'system', credentialId: undefined })]), 'system'],
      [read(null), 'system'],
      [read([grant({ fetch: endpoint('https://gitlab.com/o/r.git'), push: endpoint('https://gitlab.com/o/r.git') })]), 'system'],
    ]) {
      const { runtime, dataDir } = await setup({ binding });
      await runtime.publish();
      expect((await ask(runtime, { secret: (await readEndpoint(dataDir)).secret, body })).answer).toEqual({ mode });
    }
    const gone = await setup({ resolve: async () => { throw new Error('account unavailable'); } });
    await gone.runtime.publish();
    expect((await ask(gone.runtime, { secret: (await readEndpoint(gone.dataDir)).secret, body })).answer).toEqual({ mode: 'none' });
  });

  it('fails closed for a managed grant whose account is unavailable instead of handing it to the machine', async () => {
    const body = { cwd: '/repo', query: 'protocol=https\nhost=github.com\npath=owner/repo.git\n' };
    for (const unavailable of [grant({ readiness: 'confirmation-required' }), grant({ readiness: 'config-changed' })]) {
      const { runtime, dataDir, resolved } = await setup({ binding: read([unavailable]) });
      await runtime.publish();
      expect((await ask(runtime, { secret: (await readEndpoint(dataDir)).secret, body })).answer).toEqual({ mode: 'none' });
      expect(resolved).toHaveLength(0);
    }
  });

  it('selects the grant by repository path, so an origin and a fork on one host keep their own accounts', async () => {
    const FORK = 'https://github.com/me/repo';
    const reference = (credentialId) => createHttpsCredentialReference({ provider: 'github', instance: 'github.com', credentialId, credentialRevision: 1, providerUserId: `github.com#${credentialId}` });
    const binding = {
      ...read([grant({ credentialId: reference('company') }), grant({ name: 'fork', credentialId: reference('personal'), fetch: endpoint(FORK), push: endpoint(FORK) })]),
    };
    binding.repository = { ...binding.repository, remotes: [...binding.repository.remotes, { name: 'fork', fetch: endpoint(FORK), push: endpoint(FORK) }] };
    const { runtime, dataDir, resolved } = await setup({ binding });
    await runtime.publish();
    const { secret } = await readEndpoint(dataDir);
    const askFor = async (path) => (await ask(runtime, { secret, body: { cwd: '/repo', query: `protocol=https\nhost=github.com\n${path === null ? '' : `path=${path}\n`}` } })).answer;
    expect(await askFor('me/repo.git')).toMatchObject({ mode: 'managed' });
    expect(resolved.at(-1)).toMatchObject({ credentialId: reference('personal'), endpoint: { path: '/me/repo' } });
    expect(await askFor('owner/repo.git/info/lfs')).toMatchObject({ mode: 'managed' });
    expect(resolved.at(-1)).toMatchObject({ credentialId: reference('company') });
    // Without a path (a repository configured before path matching) two accounts are ambiguous.
    const before = resolved.length;
    expect(await askFor(null)).toEqual({ mode: 'none' });
    expect(resolved).toHaveLength(before);
    expect(await askFor('someone/else.git')).toEqual({ mode: 'system' });
  });

  it('judges the query cap in bytes, so a multi-byte query past 64 KiB is refused before the binding read', async () => {
    let bindingCalls = 0;
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-repo-credential-'));
    roots.push(dataDir);
    const runtime = createGitRepositoryCredentialRuntime({
      readBinding: async () => { bindingCalls += 1; return read(null); },
      credentialResolver: { resolve: async () => null },
      dataDir, fsPromises: fs,
      getActivePort: () => 4399,
      helperPath: '/opt/openchamber/repository-credential-helper.js',
    });
    await runtime.publish();
    const { secret } = await readEndpoint(dataDir);
    const askQuery = async (query) => (await ask(runtime, { secret, body: { cwd: '/repo', query } })).answer;
    const base = 'protocol=https\nhost=github.com\npath=';
    // ASCII over the cap: refused, binding never read (existing behaviour, pinned).
    expect(await askQuery(`${base}${'a'.repeat(70_000)}\n`)).toEqual({ mode: 'none' });
    expect(bindingCalls).toBe(0);
    // Multi-byte over the cap in bytes (67,037) but under it in characters (22,037): refused the same way.
    expect(await askQuery(`${base}${'\u20ac'.repeat(22_000)}\n`)).toEqual({ mode: 'none' });
    expect(bindingCalls).toBe(0);
    // Multi-byte within the byte cap is still answered exactly as before.
    expect(await askQuery(`${base}${'\u20ac'.repeat(100)}\n`)).toEqual({ mode: 'system' });
    expect(bindingCalls).toBe(1);
  });

  it('refuses a wrong secret, a request before publishing, and another machine', async () => {
    const { runtime, dataDir } = await setup();
    const body = { cwd: '/repo', query: 'protocol=https\nhost=github.com\n' };
    expect((await ask(runtime, { secret: 'anything', body })).status).toBe(403);
    await runtime.publish();
    const { secret } = await readEndpoint(dataDir);
    expect((await ask(runtime, { secret: 'wrong', body })).status).toBe(403);
    expect((await ask(runtime, { secret, body, remoteAddress: '192.168.1.20' })).status).toBe(403);
  });

  it('drives the real helper script: managed answers the credential, system falls through', async () => {
    const { runtime, dataDir } = await setup();
    const app = express();
    app.use(express.json());
    let mode = 'managed';
    app.post('/api/git/repository-credential', (req, res) => {
      const secretOk = req.headers.authorization === `Bearer ${JSON.parse(String(process.env.__ENDPOINT_JSON)).secret}`;
      if (!secretOk) return res.status(403).end();
      res.json(mode === 'managed' ? { mode, username: 'x-access-token', password: 'secret-value' } : { mode });
    });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const endpointFile = path.join(dataDir, 'git-credential-endpoint.json');
      const endpointJson = JSON.stringify({ version: 1, url: `http://127.0.0.1:${server.address().port}/api/git/repository-credential`, secret: 'test-secret' });
      await fs.writeFile(endpointFile, endpointJson);
      process.env.__ENDPOINT_JSON = endpointJson;
      const helper = new URL('./repository-credential-helper.js', import.meta.url).pathname;
      // The helper's fall-through runs the person's own `git credential fill` with their system config,
      // so a stub git on PATH stands in for a person who has nothing stored.
      // The stub also records what it was asked, so an empty answer cannot mean the helper never asked.
      const quietBin = path.join(dataDir, 'bin');
      const stubLog = path.join(dataDir, 'git-stub.log');
      await fs.mkdir(quietBin);
      await fs.writeFile(path.join(quietBin, 'git'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$OC_GIT_STUB_LOG"\ncat >> "$OC_GIT_STUB_LOG"\n', { mode: 0o755 });
      const run = () => new Promise((resolve) => {
        const child = execFile(process.execPath, [helper, endpointFile, 'get'], {
          env: { ...process.env, PATH: `${quietBin}${path.delimiter}${process.env.PATH}`, OC_GIT_STUB_LOG: stubLog },
        }, (_error, stdout) => resolve(stdout));
        child.stdin.end('protocol=https\nhost=github.com\n');
      });
      expect(await run()).toBe('username=x-access-token\npassword=secret-value\n\n');
      // System: the person's own chain is asked, which here holds nothing.
      mode = 'system';
      expect(await run()).toBe('');
      expect(await fs.readFile(stubLog, 'utf8')).toBe('credential fill\nprotocol=https\nhost=github.com\n');
      // A server that is not there: the same fall-through, never a hang.
      await fs.writeFile(endpointFile, JSON.stringify({ version: 1, url: 'http://127.0.0.1:1/api/git/repository-credential', secret: 's' }));
      expect(await run()).toBe('');
      expect((await fs.readFile(stubLog, 'utf8')).match(/credential fill/g)).toHaveLength(2);
    } finally {
      delete process.env.__ENDPOINT_JSON;
      await new Promise((resolve) => server.close(resolve));
    }
    void runtime;
  });

  it.skipIf(process.platform === 'win32')("bounds the delegate when the person's credential chain stalls", async () => {
    const { dataDir } = await setup();
    // No server is listening, so the helper falls through to the delegate;
    // the stub git stands in for a credential chain that never answers.
    const endpointFile = path.join(dataDir, 'git-credential-endpoint.json');
    await fs.writeFile(endpointFile, JSON.stringify({ version: 1, url: 'http://127.0.0.1:1/api/git/repository-credential', secret: 's' }));
    const hangBin = path.join(dataDir, 'hang-bin');
    await fs.mkdir(hangBin);
    await fs.writeFile(path.join(hangBin, 'git'), '#!/bin/sh\ncat > /dev/null\nexec sleep 120\n', { mode: 0o755 });
    const helper = new URL('./repository-credential-helper.js', import.meta.url).pathname;
    const startedAt = Date.now();
    const stdout = await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [helper, endpointFile, 'get'], {
        env: { ...process.env, PATH: hangBin + path.delimiter + process.env.PATH },
        timeout: 45_000,
      }, (error, out) => (error ? reject(error) : resolve(out)));
      child.stdin.end('protocol=https\nhost=github.com\n');
    });
    expect(stdout).toBe('');
    // The delegate deadline is 10s; without it the helper would wait out
    // the stub's 120s sleep.
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  }, 60_000);

  it.skipIf(process.platform === 'win32')('terminates the whole delegate tree when a real-git credential helper stalls', async () => {
    const { dataDir } = await setup();
    // No server is listening, so the helper falls through to the delegate.
    // Unlike the stub-git case above, this uses the real `git credential
    // fill`: a fake HOME gives it a global config naming a stalled
    // credential helper, so git itself launches the process that must not
    // survive the delegate deadline orphaned (#877).
    const endpointFile = path.join(dataDir, 'git-credential-endpoint.json');
    await fs.writeFile(endpointFile, JSON.stringify({ version: 1, url: 'http://127.0.0.1:1/api/git/repository-credential', secret: 's' }));
    const homeDir = path.join(dataDir, 'home');
    await fs.mkdir(homeDir);
    const pidFile = path.join(dataDir, 'stalled-helper.pid');
    const stalledHelper = path.join(dataDir, 'stalled-helper.sh');
    await fs.writeFile(stalledHelper, `#!/bin/sh\necho $$ > \"${pidFile}\"\nexec sleep 120\n`, { mode: 0o755 });
    await fs.writeFile(path.join(homeDir, '.gitconfig'), `[credential]\n\thelper = \"${stalledHelper}\"\n`);
    const helper = new URL('./repository-credential-helper.js', import.meta.url).pathname;
    const startedAt = Date.now();
    const stdout = await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [helper, endpointFile, 'get'], {
        env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: path.join(dataDir, 'xdg') },
        timeout: 45_000,
      }, (error, out) => (error ? reject(error) : resolve(out)));
      child.stdin.end('protocol=https\nhost=example.com\n');
    });
    // Fail-quiet is preserved: prompt exit at the 10s delegate deadline,
    // nothing emitted beyond what the chain answered (here, nothing).
    expect(stdout).toBe('');
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    const stalledPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    expect(Number.isInteger(stalledPid)).toBe(true);
    // The stalled helper (git's grandchild through the delegate) is gone,
    // not orphaned. Poll briefly so a just-delivered SIGKILL can settle.
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
      try { process.kill(stalledPid, 0); } catch { alive = false; }
      if (alive && process.platform === 'linux') {
        // In containers whose PID 1 does not reap orphaned children, a
        // terminated helper lingers as a zombie and kill(pid, 0) still
        // succeeds; a zombie is terminated, not a surviving helper.
        try {
          const status = await fs.readFile(`/proc/${stalledPid}/status`, 'utf8');
          if (/^State:\s+Z/m.test(status)) alive = false;
        } catch { alive = false; }
      }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(alive).toBe(false);
  }, 60_000);
});
