import { spawn } from 'node:child_process';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitCredentialBroker } from './credential-broker.js';

const brokers = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

const credential = (path) => ({
  mode: 'managed',
  transport: 'https',
  username: 'x-access-token',
  password: 'operation-secret',
  allowedEndpoint: { protocol: 'https', host: 'example.com', port: 443, path },
});

const helperInvocation = (lease) => {
  const config = lease.gitConfigArgs.at(-1);
  const values = [...config.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  return { executable: values[0], args: values.slice(1) };
};

const runHelper = async (lease, query) => {
  const invocation = helperInvocation(lease);
  return runProcess(invocation.executable, invocation.args.concat('get'), query);
};

const runProcess = (executable, args, input) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('error', reject);
  child.on('close', (code) => {
    const result = { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
    if (code === 0) resolve(result);
    else reject(Object.assign(new Error('Credential helper failed'), result));
  });
  child.stdin.end(input);
});

describe('Git credential broker', () => {
  it('serves one exact credential through the helper without putting the token in args or snapshots', async () => {
    const broker = createGitCredentialBroker();
    brokers.push(broker);
    await broker.start();
    const lease = broker.issue({ operationId: 'fetch-one', credential: credential('one/repo.git') });

    expect(lease.gitConfigArgs.join(' ')).not.toContain('operation-secret');
    expect(JSON.stringify(broker.snapshot())).not.toContain('operation-secret');
    const { stdout, stderr } = await runHelper(lease, [
      'capability[]=authtype',
      'capability[]=state',
      'protocol=https',
      'host=EXAMPLE.COM:443',
      'path=/one/repo.git',
      '',
      '',
    ].join('\n'));
    expect(stdout).toBe('username=x-access-token\npassword=operation-secret\n\n');
    expect(stderr).toBe('');
    expect(broker.snapshot().activeOperations).toBe(0);
    await expect(runHelper(lease, 'protocol=https\nhost=example.com\npath=one/repo.git\n\n')).rejects.toMatchObject({ code: 1 });
  });

  it('keeps same-host repository paths and operation ownership isolated', async () => {
    const broker = createGitCredentialBroker();
    brokers.push(broker);
    await broker.start();
    const first = broker.issue({ operationId: 'fetch-one', credential: credential('one/repo.git') });
    const second = broker.issue({ operationId: 'fetch-two', credential: { ...credential('two/repo.git'), password: 'second-secret' } });
    expect(() => broker.issue({ operationId: 'fetch-one', credential: credential('three/repo.git') }))
      .toThrow('already owns');

    await expect(runHelper(first, 'protocol=https\nhost=example.com\npath=two/repo.git\n\n')).rejects.toMatchObject({ code: 1 });
    const { stdout } = await runHelper(second, 'protocol=https\nhost=example.com\npath=two/repo.git\n\n');
    expect(stdout).toContain('second-secret');
    expect(stdout).not.toContain('operation-secret');
    expect(first.revoke()).toBe(true);
  });

  it('answers the git-lfs repository-path alias only for leases issued with it', async () => {
    const broker = createGitCredentialBroker();
    brokers.push(broker);
    await broker.start();
    const lfsEndpoint = credential('one/repo.git/info/lfs');
    const plain = broker.issue({ operationId: 'lfs-plain', credential: lfsEndpoint });
    await expect(runHelper(plain, 'protocol=https\nhost=example.com\npath=one/repo.git\n\n')).rejects.toMatchObject({ code: 1 });
    expect(plain.revoke()).toBe(true);
    const aliased = broker.issue({
      operationId: 'lfs-aliased', credential: lfsEndpoint,
      endpointAliases: [{ protocol: 'https', host: 'example.com', port: 443, path: 'one/repo.git' }],
    });
    await expect(runHelper(aliased, 'protocol=https\nhost=example.com\npath=other/repo.git\n\n')).rejects.toMatchObject({ code: 1 });
    const { stdout } = await runHelper(aliased, 'protocol=https\nhost=example.com\npath=one/repo.git\n\n');
    expect(stdout).toContain('operation-secret');
    expect(() => broker.issue({ operationId: 'lfs-bad', credential: lfsEndpoint, endpointAliases: 'one/repo.git' }))
      .toThrow('endpoint aliases');
  });

  it('allows only one of two concurrent requests to consume a lease', async () => {
    const broker = createGitCredentialBroker();
    brokers.push(broker);
    await broker.start();
    const lease = broker.issue({ operationId: 'single-consumer', credential: credential('one/repo.git') });
    const query = 'protocol=https\nhost=example.com\npath=one/repo.git\n\n';
    const results = await Promise.allSettled([runHelper(lease, query), runHelper(lease, query)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('enforces capacity, TTL cleanup, revocation, and denied helper operations', async () => {
    let currentTime = 10;
    const broker = createGitCredentialBroker({ capacity: 1, ttlMs: 5, now: () => currentTime });
    brokers.push(broker);
    await broker.start();
    const first = broker.issue({ operationId: 'first', credential: credential('one/repo.git') });
    expect(() => broker.issue({ operationId: 'second', credential: credential('two/repo.git') })).toThrow('capacity');
    currentTime = 16;
    broker.cleanup();
    expect(broker.snapshot().activeOperations).toBe(0);
    await expect(runHelper(first, 'protocol=https\nhost=example.com\npath=one/repo.git\n\n')).rejects.toMatchObject({ code: 1 });

    const second = broker.issue({ operationId: 'second', credential: credential('two/repo.git') });
    const invocation = helperInvocation(second);
    const store = await runProcess(
      invocation.executable,
      invocation.args.concat('store'),
      'protocol=https\nhost=example.com\npath=two/repo.git\n\n',
    );
    expect(store.stdout).toBe('');
    expect(broker.snapshot().activeOperations).toBe(1);
    expect(broker.revoke('second')).toBe(true);
    expect(broker.snapshot().activeOperations).toBe(0);
  });

  it('rejects credential-protocol injection in internal snapshots', async () => {
    const broker = createGitCredentialBroker();
    brokers.push(broker);
    await broker.start();
    expect(() => broker.issue({
      operationId: 'unsafe',
      credential: { ...credential('one/repo.git'), password: 'secret\nusername=attacker' },
    })).toThrow('Invalid HTTPS credential snapshot');
  });

  it('clears failed listen state so start can retry', async () => {
    const failed = new EventEmitter();
    failed.listen = vi.fn(() => queueMicrotask(() => failed.emit('error', new Error('listen failed'))));
    failed.close = vi.fn();
    const createServer = vi.fn()
      .mockReturnValueOnce(failed)
      .mockImplementation((handler) => http.createServer(handler));
    const broker = createGitCredentialBroker({ createServer });
    brokers.push(broker);

    await expect(broker.start()).rejects.toThrow('listen failed');
    await expect(broker.start()).resolves.toBeUndefined();
    expect(createServer).toHaveBeenCalledTimes(2);
    expect(broker.snapshot().listening).toBe(true);
  });
});
