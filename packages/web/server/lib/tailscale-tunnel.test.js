import { EventEmitter } from 'events';
import { describe, expect, it } from 'bun:test';

import {
  checkTailscaleRunning,
  readTailscaleOutput,
  resolveTailscaleTarget,
  startTailscaleTunnel,
} from './tailscale-tunnel.js';

const TARGET = { command: '/usr/bin/tailscale', env: { TAILSCALE_BE_CLI: '1' } };

// The address block follows cmd/tailscale/cli/serve_v2.go. The approval text
// comes from Tailscale's control server; only the link on its own line is
// fixed by the CLI (enableFeatureInteractive).
const SERVE_OUTPUT = 'Available within your tailnet:\n\nhttps://box.tail1234.ts.net:8443/\n|-- / proxy http://127.0.0.1:3000\n\nPress Ctrl+C to exit.\n';
const APPROVAL_OUTPUT = '\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n\n';

const createChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  return child;
};

const startWith = (child, options = {}) => {
  const calls = [];
  const promise = startTailscaleTunnel({
    port: 3000,
    mode: 'serve',
    httpsPort: 8443,
    target: TARGET,
    spawnImpl: (command, args, spawnOptions) => {
      calls.push({ command, args, env: spawnOptions.env });
      return child;
    },
    ...options,
  });
  return { promise, calls };
};

describe('readTailscaleOutput', () => {
  it('reads the tailnet address with its port', () => {
    expect(readTailscaleOutput(SERVE_OUTPUT)).toEqual({ publicUrl: 'https://box.tail1234.ts.net:8443' });
  });

  it('reads the approval link Tailscale prints before HTTPS is on', () => {
    expect(readTailscaleOutput(APPROVAL_OUTPUT)).toEqual({ approvalUrl: 'https://login.tailscale.com/f/serve?node=abc123' });
  });

  it('skips other links, such as a notice printed before the address', () => {
    expect(readTailscaleOutput('Update available: https://tailscale.com/kb/1067/update\n')).toEqual({});
    expect(readTailscaleOutput(`See https://tailscale.com/kb/1242\n${SERVE_OUTPUT}`)).toEqual({ publicUrl: 'https://box.tail1234.ts.net:8443' });
  });

  it('finds nothing in output without a link', () => {
    expect(readTailscaleOutput('Available within your tailnet:\n')).toEqual({});
  });
});

describe('checkTailscaleRunning', () => {
  const withStatus = (stdout, stderr = '') => checkTailscaleRunning({
    target: TARGET,
    spawnSyncImpl: () => ({ status: 0, stdout, stderr }),
  });

  it('is ready only when the backend is Running', () => {
    expect(withStatus('{"BackendState":"Running"}').ready).toBe(true);
  });

  it('asks to sign in when Tailscale needs a login', () => {
    expect(withStatus('{"BackendState":"NeedsLogin"}')).toEqual({
      ready: false,
      detail: 'Tailscale is not signed in. Open Tailscale and sign in.',
    });
  });

  it('asks to turn Tailscale on when it is stopped', () => {
    expect(withStatus('{"BackendState":"Stopped"}').detail).toBe('Tailscale is turned off. Turn it on and try again.');
  });

  it('passes on what the CLI said when tailscaled is unreachable', () => {
    expect(withStatus('', 'failed to connect to local tailscaled').detail)
      .toBe('Tailscale is not running: failed to connect to local tailscaled');
  });
});

describe('resolveTailscaleTarget', () => {
  it('runs the binary inside the macOS app, past the PATH wrapper, in CLI mode', () => {
    const target = resolveTailscaleTarget({ env: { PATH: '/usr/local/bin:/usr/bin' }, platform: 'darwin', existsSync: () => true });
    expect(target.command).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    expect(target.env.TAILSCALE_BE_CLI).toBe('1');
  });

  it('finds nothing on Linux without tailscale on PATH', () => {
    expect(resolveTailscaleTarget({ env: { PATH: '' }, platform: 'linux', existsSync: () => true })).toBeNull();
  });
});

describe('startTailscaleTunnel', () => {
  it('runs the mode in the foreground against the local port and reports the address', async () => {
    const child = createChild();
    const { promise, calls } = startWith(child);
    child.stdout.emit('data', Buffer.from(SERVE_OUTPUT));
    const controller = await promise;

    expect(calls[0].args).toEqual(['serve', '--https=8443', 'http://127.0.0.1:3000']);
    expect(calls[0].env.TAILSCALE_BE_CLI).toBe('1');
    expect(controller.getPublicUrl()).toBe('https://box.tail1234.ts.net:8443');
    expect(controller.httpsPort).toBe(8443);
  });

  it('stops the child on stop, which removes the foreground config', async () => {
    const child = createChild();
    const { promise } = startWith(child);
    child.stdout.emit('data', SERVE_OUTPUT);
    const controller = await promise;

    controller.stop();

    expect(child.signals).toEqual(['SIGINT']);
    expect(controller.getPublicUrl()).toBeNull();
  });

  it('forgets the address when Tailscale exits on its own', async () => {
    const child = createChild();
    const { promise } = startWith(child);
    child.stdout.emit('data', SERVE_OUTPUT);
    const controller = await promise;

    child.emit('exit', 1, null);

    expect(controller.getPublicUrl()).toBeNull();
  });

  it('fails at once with the approval link instead of waiting for it', async () => {
    const child = createChild();
    const { promise } = startWith(child, { mode: 'funnel', httpsPort: 443 });
    child.stdout.emit('data', APPROVAL_OUTPUT);

    const error = await promise.catch((caught) => caught);
    expect(error.code).toBe('approval_required');
    expect(error.details).toEqual({ approvalUrl: 'https://login.tailscale.com/f/serve?node=abc123' });
    expect(error.message).toContain('Turn on Funnel for your tailnet');
    expect(child.signals).toEqual(['SIGINT']);
  });

  it('tells a Linux user without operator rights how to get them', async () => {
    const child = createChild();
    const { promise } = startWith(child);
    child.stderr.emit('data', 'error: serve config denied\n');

    const error = await promise.catch((caught) => caught);
    expect(error.message).toBe('Tailscale does not let this user share ports. Run: sudo tailscale set --operator=$USER');
  });

  it('reports the last line Tailscale printed when it exits before an address', async () => {
    const child = createChild();
    const { promise } = startWith(child);
    child.stderr.emit('data', 'listener already exists for port 8443\n');
    child.emit('exit', 1, null);

    const error = await promise.catch((caught) => caught);
    expect(error.message).toBe('Tailscale serve stopped before it was ready: listener already exists for port 8443');
  });

  it('gives up after the startup timeout', async () => {
    const child = createChild();
    const { promise } = startWith(child, { startupTimeoutMs: 10 });

    const error = await promise.catch((caught) => caught);
    expect(error.message).toBe('Tailscale serve gave no address within 0.01 seconds');
    expect(child.signals).toEqual(['SIGINT']);
  });
});
