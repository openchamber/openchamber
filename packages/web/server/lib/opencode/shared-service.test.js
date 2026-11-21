import { describe, expect, it, vi } from 'vitest';

import {
  attachSharedService,
  connectSharedOpenCodeService,
  createSharedOpenCodeServiceConnector,
  isSharedOpenCodeServiceEnabled,
  parseSharedServiceEndpoint,
} from './shared-service.js';

describe('shared-service', () => {
  it('parses endpoint origin, port, and exact basic password including spaces', () => {
    expect(parseSharedServiceEndpoint({
      url: 'http://127.0.0.1:49374',
      auth: { type: 'basic', username: 'opencode', password: ' secret-pass ' },
    })).toEqual({
      origin: 'http://127.0.0.1:49374',
      port: 49374,
      password: ' secret-pass ',
    });
  });

  it('reuses a discovered shared service without spawning opencode even in enterprise mode', async () => {
    const discoverService = vi.fn(async () => ({
      url: 'http://127.0.0.1:49374',
      auth: { type: 'basic', username: 'opencode', password: 'discovered-password' },
    }));
    const ensureService = vi.fn();

    const result = await connectSharedOpenCodeService({
      binary: null,
      enterpriseMode: true,
      discoverService,
      ensureService,
    });

    expect(result).toEqual({
      origin: 'http://127.0.0.1:49374',
      port: 49374,
      password: 'discovered-password',
    });
    expect(ensureService).not.toHaveBeenCalled();
  });

  it('refuses to launch a user-configured shared service in enterprise mode when none is running', async () => {
    const ensureService = vi.fn();
    await expect(connectSharedOpenCodeService({
      binary: '/usr/local/bin/opencode',
      enterpriseMode: true,
      discoverService: async () => undefined,
      ensureService,
    })).rejects.toThrow(/Enterprise mode does not start/);
    expect(ensureService).not.toHaveBeenCalled();
  });

  it('replaces a running service older than the installed CLI and keeps one that is not older', async () => {
    const ensureService = vi.fn(async ({ onStart }) => {
      onStart('version-mismatch', '2.3.0');
      return { url: 'http://127.0.0.1:49376', auth: undefined };
    });
    const discoverService = vi.fn();

    const result = await connectSharedOpenCodeService({
      binary: '/usr/local/bin/opencode',
      platform: 'darwin',
      enterpriseMode: false,
      env: { PATH: '/usr/local/bin' },
      discoverService,
      ensureService,
      readCliVersion: async () => '2.3.2',
    });

    expect(result).toEqual({ origin: 'http://127.0.0.1:49376', port: 49376, password: null, replaced: true });
    expect(discoverService).not.toHaveBeenCalled();
    const { version } = ensureService.mock.calls[0][0];
    expect(version('2.3.0')).toBe(false);
    expect(version('2.3.2')).toBe(true);
    expect(version('2.4.0')).toBe(true);
    expect(version('0.0.0-next-9')).toBe(true);
  });

  it('reuses whatever service runs when the CLI is a preview build or the caller only restores state', async () => {
    const running = { url: 'http://127.0.0.1:49374', auth: undefined };
    const ensureService = vi.fn();
    const readCliVersion = vi.fn(async () => '0.0.0-next-10');
    const options = { binary: '/usr/local/bin/opencode', enterpriseMode: false, discoverService: async () => running, ensureService, readCliVersion };

    expect((await connectSharedOpenCodeService(options)).port).toBe(49374);
    expect((await connectSharedOpenCodeService({ ...options, readCliVersion: async () => '2.3.2', replaceOutdated: false })).port).toBe(49374);
    expect(ensureService).not.toHaveBeenCalled();
  });

  it('reads the version from and launches the service with the resolved executable, not a Windows shim', async () => {
    const ensureService = vi.fn(async () => ({ url: 'http://127.0.0.1:49376', auth: undefined }));
    const readCliVersion = vi.fn(async () => '2.3.2');
    await connectSharedOpenCodeService({
      binary: 'C:\\npm\\opencode.cmd',
      platform: 'win32',
      enterpriseMode: false,
      env: { PATH: '' },
      discoverService: vi.fn(),
      ensureService,
      resolveLaunch: () => ({ binary: 'C:\\npm\\opencode.exe', args: [] }),
      readCliVersion,
    });

    expect(readCliVersion.mock.calls[0][0]).toEqual({ binary: 'C:\\npm\\opencode.exe', args: [] });
    expect(ensureService.mock.calls[0][0].command).toEqual(['C:\\npm\\opencode.exe', 'serve', '--service']);
  });

  it('reuses whatever service runs when the installed CLI version cannot be read', async () => {
    const ensureService = vi.fn();
    const result = await connectSharedOpenCodeService({
      binary: '/usr/local/bin/opencode',
      enterpriseMode: false,
      discoverService: async () => ({ url: 'http://127.0.0.1:49374', auth: undefined }),
      ensureService,
      readCliVersion: async () => { throw new Error('spawn failed'); },
    });

    expect(result.port).toBe(49374);
    expect(ensureService).not.toHaveBeenCalled();
  });

  it('unsets protected env vars via /usr/bin/env -u on POSIX when starting opencode serve --service', async () => {
    const discoverService = vi.fn(async () => undefined);
    const ensureService = vi.fn(async () => ({
      url: 'http://127.0.0.1:49375',
      auth: { type: 'basic', username: 'opencode', password: 'started-password' },
    }));

    const result = await connectSharedOpenCodeService({
      binary: '/usr/local/bin/opencode',
      platform: 'darwin',
      enterpriseMode: false,
      env: {
        PATH: '/usr/local/bin',
        OPENCODE_PASSWORD: 'leak',
        OPENCODE_SERVER_PASSWORD: 'leak',
        OPENCODE_CONFIG: '/tmp/managed.json',
        OPENCHAMBER_AGENT_TOOL_URL: 'http://127.0.0.1:1/tool',
      },
      discoverService,
      ensureService,
      readCliVersion: async () => '2.3.2',
    });

    expect(result).toEqual({
      origin: 'http://127.0.0.1:49375',
      port: 49375,
      password: 'started-password',
      replaced: false,
    });
    expect(ensureService).toHaveBeenCalledWith({
      version: expect.any(Function),
      onStart: expect.any(Function),
      command: [
        '/usr/bin/env',
        '-u', 'OPENCODE_PASSWORD',
        '-u', 'OPENCODE_SERVER_PASSWORD',
        '-u', 'OPENCODE_CONFIG',
        '-u', 'OPENCODE_CONFIG_CONTENT',
        '-u', 'OPENCHAMBER_AGENT_TOOL_URL',
        '-u', 'OPENCHAMBER_AGENT_TOOL_TOKEN',
        '/usr/local/bin/opencode',
        'serve',
        '--service',
      ],
      env: { PATH: '/usr/local/bin' },
    });
  });

  it('refuses to spawn serve --service using a bundled .mjs server launcher when no CLI is on PATH', async () => {
    await expect(connectSharedOpenCodeService({
      binary: '/Applications/OpenChamber.app/Contents/Resources/opencode-server/server.mjs',
      env: { PATH: '' },
      enterpriseMode: false,
      discoverService: async () => undefined,
      ensureService: vi.fn(),
    })).rejects.toThrow(/No running shared OpenCode service was found/);
  });

  it('keeps the existing managed process running if connecting to the shared service fails', async () => {
    const close = vi.fn(async () => {});
    const killProcessOnPort = vi.fn();
    const connector = createSharedOpenCodeServiceConnector({
      readSettings: () => ({ useGlobalOpenCodeService: true }),
      resolveBinary: () => null,
      buildEnv: () => ({ PATH: '' }),
      setAuthPassword: vi.fn(() => null),
      discoverService: async () => undefined,
      ensureService: vi.fn(),
    });
    const state = {
      openCodeBaseUrl: null,
      openCodePort: 4096,
      isOpenCodeReady: true,
      isExternalOpenCode: false,
      lastOpenCodeError: null,
      openCodeNotReadySince: 0,
      openCodeProcess: { close },
      expressApp: {},
    };

    await expect(attachSharedService(connector, {
      state,
      setOpenCodePort: vi.fn(),
      recordDiagnostic: vi.fn(),
      syncToHmrState: vi.fn(),
      killProcessOnPort,
      waitForPortRelease: vi.fn(async () => true),
      setupProxy: vi.fn(),
      ensureOpenCodeApiPrefix: vi.fn(),
      onOpenCodeRestarted: vi.fn(),
    }, { stopManaged: true })).rejects.toThrow();

    expect(close).not.toHaveBeenCalled();
    expect(killProcessOnPort).not.toHaveBeenCalled();
    expect(state.isOpenCodeReady).toBe(true);
    expect(state.isExternalOpenCode).toBe(false);
    expect(state.openCodeProcess).not.toBeNull();
  });

  it('attaches shared service state and stops the previous managed process only after connecting', async () => {
    const close = vi.fn(async () => {});
    const setOpenCodePort = vi.fn();
    const setAuthPassword = vi.fn(() => 'pw');
    const killProcessOnPort = vi.fn();
    const waitForPortRelease = vi.fn(async () => true);
    const setupProxy = vi.fn();
    const ensureOpenCodeApiPrefix = vi.fn();
    const onOpenCodeRestarted = vi.fn();
    const syncToHmrState = vi.fn();
    const recordDiagnostic = vi.fn();

    const connector = createSharedOpenCodeServiceConnector({
      readSettings: () => ({ useGlobalOpenCodeService: true }),
      resolveBinary: () => '/usr/local/bin/opencode',
      buildEnv: () => ({}),
      setAuthPassword,
      readCliVersion: async () => { throw new Error('not installed'); },
      discoverService: async () => ({
        url: 'http://127.0.0.1:49374',
        auth: { type: 'basic', username: 'opencode', password: 'pw' },
      }),
    });

    expect(isSharedOpenCodeServiceEnabled({ useGlobalOpenCodeService: true })).toBe(true);
    expect(await connector.isEnabled()).toBe(true);

    const state = {
      openCodeBaseUrl: null,
      openCodePort: 4096,
      isOpenCodeReady: false,
      isExternalOpenCode: false,
      lastOpenCodeError: 'old',
      openCodeNotReadySince: 123,
      openCodeProcess: { close },
      expressApp: {},
    };

    await attachSharedService(connector, {
      state,
      setOpenCodePort,
      recordDiagnostic,
      syncToHmrState,
      killProcessOnPort,
      waitForPortRelease,
      setupProxy,
      ensureOpenCodeApiPrefix,
      onOpenCodeRestarted,
    }, { stopManaged: true });

    expect(close).toHaveBeenCalledTimes(1);
    expect(killProcessOnPort).toHaveBeenCalledWith(4096);
    expect(setAuthPassword).toHaveBeenCalledWith('pw', 'shared-service');
    expect(setOpenCodePort).toHaveBeenCalledWith(49374);
    expect(state.openCodeBaseUrl).toBe('http://127.0.0.1:49374');
    expect(state.isExternalOpenCode).toBe(true);
    expect(state.isOpenCodeReady).toBe(true);
    expect(state.openCodeProcess).toBeNull();
    expect(setupProxy).toHaveBeenCalledTimes(1);
    expect(ensureOpenCodeApiPrefix).toHaveBeenCalledTimes(1);
    expect(onOpenCodeRestarted).toHaveBeenCalledTimes(1);
  });
});
