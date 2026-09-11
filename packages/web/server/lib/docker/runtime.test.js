import { describe, expect, it, vi } from 'vitest';

import { createDockerRuntime } from './runtime.js';

const createExecFileStub = ({ stdout = '', stderr = '', failure = null } = {}) => {
  const calls = [];
  const impl = vi.fn(async (file, args, options) => {
    calls.push({ file, args, options });
    if (failure) {
      if (failure.enoent) {
        const error = new Error('spawn docker ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      if (failure.timeout) {
        const error = new Error('command killed');
        error.killed = true;
        error.stderr = '';
        throw error;
      }
      const error = new Error(failure.message ?? 'command failed');
      error.code = failure.code ?? 1;
      error.stderr = failure.stderr ?? stderr;
      throw error;
    }
    return { stdout, stderr: '' };
  });
  return { impl, calls };
};

describe('createDockerRuntime', () => {
  it('isAvailable resolves true when the daemon answers the version probe', async () => {
    const { impl } = createExecFileStub({ stdout: '27.1.1\n' });
    const runtime = createDockerRuntime({ execFileImpl: impl });
    await expect(runtime.isAvailable()).resolves.toBe(true);
    expect(impl.mock.calls[0][1]).toEqual(['version', '--format', '{{.Server.Version}}']);
  });

  it('isAvailable resolves false when the CLI is missing and does not throw', async () => {
    const { impl } = createExecFileStub({ failure: { enoent: true } });
    const runtime = createDockerRuntime({ execFileImpl: impl, logger: { warn: () => {} } });
    await expect(runtime.isAvailable()).resolves.toBe(false);
  });

  it('isAvailable resolves false when the probe times out', async () => {
    const { impl } = createExecFileStub({ failure: { timeout: true } });
    const runtime = createDockerRuntime({ execFileImpl: impl, logger: { warn: () => {} } });
    await expect(runtime.isAvailable()).resolves.toBe(false);
  });

  it('createContainer builds argument-array commands without a shell and loopback-only publishing', async () => {
    const { impl, calls } = createExecFileStub({ stdout: 'abc123\n' });
    const runtime = createDockerRuntime({ execFileImpl: impl });
    const containerId = await runtime.createContainer({
      name: 'openchamber-opencode-x',
      image: 'opencode-instance:local',
      labels: { 'openchamber.instance': 'x' },
      env: { OPENCODE_PORT: '4096' },
      binds: [{ host: 'C:\\proj', container: '/workspace', mode: 'rw' }],
      portBindings: { '4096/tcp': { hostIp: '127.0.0.1', hostPort: 4567 } },
    });
    expect(containerId).toBe('abc123');
    const args = calls[0].args;
    expect(args[0]).toBe('create');
    expect(args).not.toContain('--privileged');
    const publishIndex = args.indexOf('--publish');
    expect(args[publishIndex + 1]).toBe('127.0.0.1:4567:4096');
    const volumeIndex = args.indexOf('--volume');
    expect(args[volumeIndex + 1]).toBe('C:\\proj:/workspace:rw');
    expect(args[args.length - 1]).toBe('opencode-instance:local');
    expect(calls[0].options.timeout).toBeGreaterThan(0);
    expect(calls[0].options.windowsHide).toBe(true);
  });

  it('createContainer rejects an empty container id as bad output', async () => {
    const { impl } = createExecFileStub({ stdout: '   \n' });
    const runtime = createDockerRuntime({ execFileImpl: impl });
    await expect(runtime.createContainer({ name: 'n', image: 'img' })).rejects.toMatchObject({
      code: 'DOCKER_BAD_OUTPUT',
    });
  });

  it('imageExists resolves false for inspect failures but rethrows CLI/timeout failures', async () => {
    const missing = createExecFileStub({ failure: { message: 'no such image', code: 1 } });
    const runtime = createDockerRuntime({ execFileImpl: missing.impl });
    await expect(runtime.imageExists('ghost:1')).resolves.toBe(false);

    const enoent = createExecFileStub({ failure: { enoent: true } });
    const runtime2 = createDockerRuntime({ execFileImpl: enoent.impl });
    await expect(runtime2.imageExists('ghost:1')).rejects.toMatchObject({ code: 'DOCKER_CLI_MISSING' });
  });

  it('stopContainer passes the force timeout and derives the command timeout from it', async () => {
    const { impl, calls } = createExecFileStub({});
    const runtime = createDockerRuntime({ execFileImpl: impl });
    await runtime.stopContainer('abc', { timeoutSeconds: 5 });
    const args = calls[0].args;
    expect(args).toEqual(['stop', '--time', '5', 'abc']);
    expect(calls[0].options.timeout).toBe(15_000);
  });

  it('removeContainer forces removal when requested', async () => {
    const { impl, calls } = createExecFileStub({});
    const runtime = createDockerRuntime({ execFileImpl: impl });
    await runtime.removeContainer('abc', { force: true });
    expect(calls[0].args).toEqual(['rm', '--force', 'abc']);
  });

  it('inspectContainer returns null when the container is missing but parses payloads when present', async () => {
    const missing = createExecFileStub({ failure: { message: 'no such container', code: 1 } });
    const runtime = createDockerRuntime({ execFileImpl: missing.impl });
    await expect(runtime.inspectContainer('nope')).resolves.toBeNull();

    const present = createExecFileStub({ stdout: JSON.stringify([{ Id: 'abc' }]) });
    const runtime2 = createDockerRuntime({ execFileImpl: present.impl });
    await expect(runtime2.inspectContainer('abc')).resolves.toEqual({ Id: 'abc' });
  });

  it('listContainersByLabel filters via label and trims ids', async () => {
    const { impl, calls } = createExecFileStub({ stdout: 'id1\nid2\n\n' });
    const runtime = createDockerRuntime({ execFileImpl: impl });
    await expect(runtime.listContainersByLabel('openchamber.instance=x')).resolves.toEqual(['id1', 'id2']);
    expect(calls[0].args).toContain('label=openchamber.instance=x');
  });

  it('surfaces command failures with a bounded stderr tail', async () => {
    const { impl } = createExecFileStub({ failure: { stderr: 'x'.repeat(5000) } });
    const runtime = createDockerRuntime({ execFileImpl: impl });
    const error = await runtime.stopContainer('abc').catch((caught) => caught);
    expect(error.code).toBe(1);
    expect(error.stderr.length).toBeLessThanOrEqual(2000);
  });
});
