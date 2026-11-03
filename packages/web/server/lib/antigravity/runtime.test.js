import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAntigravityRuntime } from './runtime.js';

const spawnMock = vi.fn(() => {
  throw new Error('spawn must not be reached');
});
const writeFileMock = vi.fn(async () => {});

const createRuntime = ({ settings, enterprise = false, external = false } = {}) => {
  if (enterprise) process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
  return createAntigravityRuntime({
    crypto: { randomBytes },
    fs: { statSync: () => ({ isFile: () => true }) },
    fsPromises: { mkdir: vi.fn(async () => {}), writeFile: writeFileMock },
    path: { join: (...parts) => parts.join('/') },
    spawn: spawnMock,
    instanceDir: '/tmp/instance',
    readSettings: () => settings ?? { antigravityDelegationEnabled: true },
    resolveSessionDirectory: () => '/tmp/project',
    getActivePort: () => 1234,
    getActiveHost: () => '127.0.0.1',
    isExternalOpenCode: () => external,
  });
};

describe('Antigravity delegation gate', () => {
  afterEach(() => {
    delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    spawnMock.mockClear();
    writeFileMock.mockClear();
  });

  it('refuses every call in enterprise mode, even with delegation enabled', async () => {
    const runtime = createRuntime({ enterprise: true });
    await expect(runtime.run({ prompt: 'hello', sessionID: 'ses_1' }))
      .rejects.toMatchObject({ code: 'ENTERPRISE_MODE' });
  });

  it('does not start the CLI to answer the status route in enterprise mode', async () => {
    const runtime = createRuntime({ enterprise: true });
    await expect(runtime.status({ force: true })).resolves.toMatchObject({
      installed: false,
      models: [],
      blocked: true,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports an external OpenCode and refuses to run there', async () => {
    const runtime = createRuntime({ external: true });
    await expect(runtime.status({ force: true })).resolves.toMatchObject({ managed: false });
    await expect(runtime.materializePlugin()).resolves.toBeNull();
    await expect(runtime.run({ prompt: 'hello', sessionID: 'ses_1' }))
      .rejects.toMatchObject({ code: 'EXTERNAL_OPENCODE' });
  });

  it('refuses a call while the setting is off', async () => {
    const runtime = createRuntime({ settings: { antigravityDelegationEnabled: false } });
    await expect(runtime.run({ prompt: 'hello', sessionID: 'ses_1' }))
      .rejects.toMatchObject({ code: 'DISABLED' });
  });

  it('does not materialize the plugin while delegation is off', async () => {
    const runtime = createRuntime({ settings: { antigravityDelegationEnabled: false } });
    await expect(runtime.materializePlugin()).resolves.toBeNull();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('rejects a model or conversation id that is not a token', async () => {
    const runtime = createRuntime();
    await expect(runtime.run({ prompt: 'hello', sessionID: 'ses_1', model: '--sandbox' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(runtime.run({ prompt: 'hello', sessionID: 'ses_1', conversation: 'a/b' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('writes a plugin that registers the tool, the command and the skill', async () => {
    const runtime = createRuntime();
    await expect(runtime.materializePlugin()).resolves.toBe('/tmp/instance/antigravity/openchamber-antigravity');
    const source = writeFileMock.mock.calls.find(([file]) => String(file).endsWith('index.js'))?.[1];
    expect(source).toContain('name: "agy"');
    expect(source).toContain('ctx.command.transform');
    expect(source).toContain('ctx.skill.transform');
    expect(source).toContain('openchamber-antigravity');
    expect(source).toContain('PERMISSION_DENIED');
  });

  it('reports a missing CLI instead of spawning', async () => {
    const path = process.env.PATH;
    process.env.PATH = '';
    try {
      const runtime = createRuntime();
      await expect(runtime.run({ prompt: 'hello', sessionID: 'ses_1' }))
        .rejects.toMatchObject({ code: 'AGY_NOT_FOUND' });
    } finally {
      process.env.PATH = path;
    }
  });

  it('mints a callback URL and token for the managed child', async () => {
    const runtime = createRuntime();
    await expect(runtime.createChildEnv()).resolves.toEqual({
      OPENCHAMBER_ANTIGRAVITY_URL: 'http://127.0.0.1:1234/api/antigravity/run',
      OPENCHAMBER_ANTIGRAVITY_TOKEN: expect.any(String),
    });
  });
});
