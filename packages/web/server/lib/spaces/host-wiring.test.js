import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostdServer } from '../hostd/server.js';
import { createSpacesHost } from './host.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('host place registration', () => {
  const build = async (platform) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-wiring-'));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    // A hostd at a socket of the test's own, which records every request it gets.
    const requests = [];
    const hostd = createHostdServer({ request: async (request) => { requests.push(request.op); return { available: false, code: 'hostd_missing', message: 'test' }; } });
    const socketPath = path.join(dataDir, 'hostd.sock');
    await new Promise((resolve) => { hostd.server.listen(socketPath, resolve); });
    cleanups.push(() => hostd.close());
    const runCommand = vi.fn();
    const host = createSpacesHost({ dataDir, platform, hostdSocketPath: socketPath, sshDockerHost: 'ssh://dev@box', runCommand });
    cleanups.push(() => host.close());
    return { host, runCommand, requests };
  };
  it('registers host first and root last on Linux without probing either runtime', async () => {
    const { host, runCommand, requests } = await build('linux');
    expect(host.places().map((place) => place.id)).toEqual(['host', 'docker', 'docker-ssh', 'host-root']);
    expect(requests).toEqual([]);
    expect(runCommand).not.toHaveBeenCalled();
    // Both host places ask the hostd at the socket they were given.
    await host.places()[0].check();
    await host.places()[3].check();
    expect(requests).toEqual(['check', 'check']);
  });
  it.each(['darwin', 'win32'])('keeps Docker registration unchanged on %s', async (platform) => {
    const { host, requests } = await build(platform);
    expect(host.places().map((place) => place.id)).toEqual(['docker', 'docker-ssh']);
    expect(requests).toEqual([]);
  });
});
