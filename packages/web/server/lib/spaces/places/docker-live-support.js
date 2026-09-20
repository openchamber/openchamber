// Test support for the suites that talk to a real Docker daemon.
// They run only with OPENCHAMBER_TEST_DOCKER=1.

import crypto from 'node:crypto';

import { expect } from 'vitest';

import { LABEL_MARKER, LABEL_OWNER, ROLE_SPACE, spaceResourceName } from '../labels.js';
import { runCommand } from '../run-command.js';
import { SPACE_BASE_IMAGE, createDockerPlace } from './docker.js';

export const LIVE_DOCKER_ENABLED = process.env.OPENCHAMBER_TEST_DOCKER === '1';

const LISTINGS = [
  ['ps', '--all', '--format', '{{.Names}}'],
  ['network', 'ls', '--format', '{{.Name}}'],
  ['volume', 'ls', '--format', '{{.Name}}'],
];

const HOST_LISTENER = (port) => `
const routes = require('node:fs').readFileSync('/proc/net/fib_trie', 'utf8');
const local = [...routes.matchAll(/\\|-- (\\d+\\.\\d+\\.\\d+\\.\\d+)\\n\\s+\\/32 host LOCAL/g)].map((match) => match[1]);
const addresses = [...new Set(local)].filter((address) => !address.startsWith('127.'));
require('node:net').createServer((socket) => { socket.on('error', () => {}); socket.end('host'); }).listen(${port}, '0.0.0.0', () => console.log(JSON.stringify(addresses)));
`;

/** A Docker place with an owner id of its own, so parallel runs and real spaces stay apart. */
export function createLiveDockerPlace() {
  const owner = `test-${crypto.randomBytes(6).toString('hex')}`;
  const place = createDockerPlace({ runCommand, dockerPath: 'docker', owner });
  const ownerFilter = ['--filter', `label=${LABEL_MARKER}`, '--filter', `label=${LABEL_OWNER}=${owner}`];
  // Helper containers carry the marker and the owner, so the leftover check sees them. They have no space id.
  const helperLabels = ['--label', `${LABEL_MARKER}=true`, '--label', `${LABEL_OWNER}=${owner}`];

  const docker = async (args, options) => {
    const result = await runCommand('docker', args, options);
    expect(result.code, `docker ${args[0]}: ${result.stderr}`).toBe(0);
    return result;
  };

  const leftovers = async () => {
    const names = [];
    for (const listing of LISTINGS) {
      names.push(...(await docker([...listing, ...ownerFilter])).stdout.split('\n').filter(Boolean));
    }
    return names;
  };

  const host = {
    runUnrestricted: (script) => docker(['run', '--rm', ...helperLabels, SPACE_BASE_IMAGE, 'node', '-e', script], { timeoutMs: 120_000 }),

    // `--network host` puts the listener on the Docker host itself: the Colima VM here, the machine on Linux.
    // It prints every IPv4 address of that host first, read from the kernel's local route table.
    // `os.networkInterfaces()` would miss a bridge that has no running container yet. On an engine that ignores the isolated gateway mode,
    // that list holds the gateway of the space's own bridge, which is the address the leak was measured on.
    startHostListener: async () => {
      const port = 20_000 + crypto.randomInt(20_000);
      const name = `openchamber-test-listener-${owner}`;
      await docker(['run', '--detach', '--name', name, ...helperLabels, '--network', 'host', SPACE_BASE_IMAGE, 'node', '-e', HOST_LISTENER(port)], { timeoutMs: 120_000 });
      let addresses = [];
      for (let attempt = 0; attempt < 40 && addresses.length === 0; attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 250); });
        const firstLine = (await docker(['logs', name])).stdout.split('\n')[0];
        addresses = firstLine.startsWith('[') ? JSON.parse(firstLine) : [];
      }
      expect(addresses.length, 'the host listener reported no address').toBeGreaterThan(0);
      // Docker Desktop injects the two names. They are tolerated when they do not resolve.
      return { port, candidates: [...addresses, 'host.docker.internal', 'gateway.docker.internal'], stop: () => docker(['rm', '--force', name]) };
    },

    // An internal network as the space network was before the isolated gateway mode. A probe from it
    // must reach the host, or the host-listener test could never fail and proves nothing.
    createPlainInternalNetwork: async () => {
      const name = `openchamber-test-plain-${owner}`;
      await docker(['network', 'create', '--driver', 'bridge', '--internal', '--ipv6=false', ...helperLabels, name]);
      return {
        run: (script) => docker(['run', '--rm', ...helperLabels, '--network', name, SPACE_BASE_IMAGE, 'node', '-e', script], { timeoutMs: 120_000 }),
        remove: () => docker(['network', 'rm', name]),
      };
    },

    logBytes: async (spaceId) => {
      const result = await docker(['logs', spaceResourceName(spaceId, ROLE_SPACE)], { maxOutputBytes: 128 * 1024 * 1024, timeoutMs: 120_000 });
      return Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    },
  };

  /** Removes every space and helper of this run, then asserts that Docker holds nothing with this owner label. */
  const dispose = async () => {
    for (const space of await place.list()) {
      await place.remove(space.id);
    }
    for (const helper of (await docker([...LISTINGS[0], ...ownerFilter])).stdout.split('\n').filter(Boolean)) {
      await docker(['rm', '--force', helper]);
    }
    for (const network of (await docker([...LISTINGS[1], ...ownerFilter])).stdout.split('\n').filter(Boolean)) {
      await docker(['network', 'rm', network]);
    }
    expect(await leftovers()).toEqual([]);
  };

  return { place, dispose, host };
}
