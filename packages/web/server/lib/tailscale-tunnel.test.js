import { EventEmitter } from 'events';
import { describe, expect, it } from 'bun:test';

import {
  checkTailscaleAvailable,
  checkTailscaleStatus,
  extractTailscalePublicUrlFromText,
  startTailscaleTunnel,
} from './tailscale-tunnel.js';
import { TUNNEL_MODE_PRIVATE_NETWORK, TUNNEL_MODE_QUICK } from './tunnels/types.js';

const createChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return true;
  };
  return child;
};

const readyOptions = (spawnImpl) => ({
  spawnImpl,
  availabilityCheck: async () => ({ available: true, path: 'tailscale', env: {} }),
  statusCheck: async () => ({ ready: true }),
  startupTimeoutMs: 100,
});

const waitForSpawn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Tailscale tunnel startup', () => {
  it('checks the installed Tailscale CLI with version', async () => {
    const result = await checkTailscaleAvailable({
      resolveExecutableLaunchTargetImpl: () => ({ command: '/usr/bin/tailscale', env: {} }),
      spawnSyncImpl: (_command, args) => {
        expect(args).toEqual(['version']);
        return { status: 0, stdout: '1.80.0', stderr: '' };
      },
    });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.80.0');
  });
  it('uses foreground Serve and Funnel commands without reset or background flags', async () => {
    for (const [mode, command] of [
      [TUNNEL_MODE_PRIVATE_NETWORK, 'serve'],
      [TUNNEL_MODE_QUICK, 'funnel'],
    ]) {
      const child = createChild();
      let args;
      const startup = startTailscaleTunnel({
        ...readyOptions((_command, commandArgs) => {
          args = commandArgs;
          return child;
        }),
        mode,
        port: 4310,
        tailscaleHttpsPort: mode === TUNNEL_MODE_PRIVATE_NETWORK ? 9443 : 10000,
      });
      await waitForSpawn();
      child.stdout.emit('data', `Available at https://work.example.ts.net/\n`);
      const controller = await startup;

      expect(args).toEqual([command, `--https=${mode === TUNNEL_MODE_PRIVATE_NETWORK ? 9443 : 10000}`, '4310']);
      expect(args).not.toContain('--bg');
      expect(args).not.toContain('reset');
      expect(controller.getPublicUrl()).toBe('https://work.example.ts.net');
    }
  });

  it('accepts arbitrary valid Serve frontend ports and rejects invalid values', async () => {
    for (const tailscaleHttpsPort of [0, 65536, '9443.5']) {
      await expect(startTailscaleTunnel({
        ...readyOptions(() => createChild()),
        mode: TUNNEL_MODE_PRIVATE_NETWORK,
        port: 4313,
        tailscaleHttpsPort,
      })).rejects.toThrow(/Tailscale Serve HTTPS frontend port.*integer from 1 to 65535/);
    }
  });

  it('rejects custom Funnel frontend ports', async () => {
    await expect(startTailscaleTunnel({
      ...readyOptions(() => createChild()),
      mode: TUNNEL_MODE_QUICK,
      port: 4314,
      tailscaleHttpsPort: 9443,
    })).rejects.toThrow(/Tailscale Funnel HTTPS frontend port.*Allowed ports: 443, 8443, 10000/);
  });

  it('detects Tailscale URLs emitted on stderr', async () => {
    const child = createChild();
    const startup = startTailscaleTunnel({
      ...readyOptions(() => child),
      mode: TUNNEL_MODE_QUICK,
      port: 4311,
    });
    await waitForSpawn();
    child.stderr.emit('data', 'https://machine.tailnet.ts.net/\n');

    await expect(startup).resolves.toMatchObject({ mode: TUNNEL_MODE_QUICK });
    expect(extractTailscalePublicUrlFromText('url: https://machine.tailnet.ts.net/')).toBe('https://machine.tailnet.ts.net');
  });

  it('reports startup failure output when the foreground child exits', async () => {
    const child = createChild();
    const startup = startTailscaleTunnel({
      ...readyOptions(() => child),
      mode: TUNNEL_MODE_PRIVATE_NETWORK,
      port: 4312,
    });
    await waitForSpawn();
    child.stderr.emit('data', 'serve failed: permission denied');
    child.emit('exit', 1, null);

    await expect(startup).rejects.toThrow(/serve failed: permission denied/);
  });

  it('reports daemon and login blockers from status JSON', async () => {
    const result = await checkTailscaleStatus({
      tailscalePath: 'tailscale',
      spawnSyncImpl: (_command, args) => {
        expect(args).toEqual(['status', '--json']);
        return {
          status: 0,
          stdout: JSON.stringify({ BackendState: 'NeedsLogin' }),
          stderr: '',
        };
      },
    });

    expect(result.ready).toBe(false);
    expect(result.blocker).toBe('login');
    expect(result.detail).toContain('tailscale up');
  });

  it('sends SIGINT only once when cleanup is repeated', async () => {
    const child = createChild();
    const startup = startTailscaleTunnel({
      ...readyOptions(() => child),
      mode: TUNNEL_MODE_PRIVATE_NETWORK,
      port: 4313,
    });
    await waitForSpawn();
    child.stdout.emit('data', 'https://machine.tailnet.ts.net');
    const controller = await startup;

    controller.stop();
    controller.stop();

    expect(child.killSignals).toEqual(['SIGINT']);
  });

  it('invalidates the URL when the foreground child exits after readiness', async () => {
    const child = createChild();
    const startup = startTailscaleTunnel({
      ...readyOptions(() => child),
      mode: TUNNEL_MODE_PRIVATE_NETWORK,
      port: 4314,
    });
    await waitForSpawn();
    child.stdout.emit('data', 'https://machine.tailnet.ts.net');
    const controller = await startup;

    expect(controller.getPublicUrl()).toBe('https://machine.tailnet.ts.net');
    child.emit('exit', 1, null);
    expect(controller.getPublicUrl()).toBeNull();
  });

  it('bounds synchronous CLI probes and reports timeouts clearly', async () => {
    let versionOptions;
    const availability = await checkTailscaleAvailable({
      resolveExecutableLaunchTargetImpl: () => ({ command: 'tailscale', env: {} }),
      commandTimeoutMs: 41,
      spawnSyncImpl: (_command, _args, options) => {
        versionOptions = options;
        return { status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' };
      },
    });

    let statusOptions;
    const status = await checkTailscaleStatus({
      tailscalePath: 'tailscale',
      commandTimeoutMs: 42,
      spawnSyncImpl: (_command, _args, options) => {
        statusOptions = options;
        return { status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' };
      },
    });

    expect(versionOptions.timeout).toBe(41);
    expect(availability.blocker).toBe('timeout');
    expect(availability.message).toContain('timed out');
    expect(statusOptions.timeout).toBe(42);
    expect(status.blocker).toBe('timeout');
    expect(status.detail).toContain('timed out');
  });


  it('turns listener conflicts into actionable frontend-port errors', async () => {
    const child = createChild();
    const startup = startTailscaleTunnel({
      ...readyOptions(() => child),
      mode: TUNNEL_MODE_PRIVATE_NETWORK,
      port: 4315,
      tailscaleHttpsPort: 8443,
    });
    await waitForSpawn();
    child.stderr.emit('data', 'listener already exists for port 8443');
    child.emit('exit', 1, null);

    await expect(startup).rejects.toThrow(/HTTPS frontend port 8443.*1 to 65535/);
  });
});
