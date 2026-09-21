// Test support for the suites that talk to a real Docker daemon.
// They run only with OPENCHAMBER_TEST_DOCKER=1.

import crypto from 'node:crypto';

import { expect } from 'vitest';

import { LABEL_MARKER, LABEL_OWNER, ROLE_GATEKEEPER, ROLE_NETWORK, ROLE_OUTER_NETWORK, ROLE_SPACE, spaceResourceName } from '../labels.js';
import { runCommand } from '../run-command.js';
import { createRegistryToolsSource, readHostToolVersions } from '../tools.js';
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

/**
 * A Docker place with an owner id of its own, so parallel runs and real spaces stay apart.
 * The owner also gets a tools volume of its own, so the first create of every live file pays for one fill.
 * `placeWith(toolsSource)` makes another place for the same owner, as a host with other tools would be.
 */
export function createLiveDockerPlace({ toolsSource = createRegistryToolsSource(readHostToolVersions()) } = {}) {
  const owner = `test-${crypto.randomBytes(6).toString('hex')}`;
  const placeWith = (source) => createDockerPlace({ runCommand, dockerPath: 'docker', owner, toolsSource: source });
  const place = placeWith(toolsSource);
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

    // Everything the place's own records show about the space container. A secret must not be in here.
    spaceMetadata: async (spaceId) => (await docker(['inspect', spaceResourceName(spaceId, ROLE_SPACE)])).stdout,

    // The same for the gatekeeper, which is where the secrets are.
    gatekeeperMetadata: async (spaceId) => (await docker(['inspect', spaceResourceName(spaceId, ROLE_GATEKEEPER)])).stdout,

    /** The space container's own address on its inner network, as Docker gave it. */
    spaceAddress: async (spaceId) => {
      const [entry] = JSON.parse((await docker(['inspect', spaceResourceName(spaceId, ROLE_SPACE)])).stdout);
      return entry.NetworkSettings.Networks[spaceResourceName(spaceId, ROLE_NETWORK)]?.IPAddress ?? '';
    },

    /** The gatekeeper's own addresses, `{ inner, outer }`, as Docker gave them. */
    gatekeeperAddresses: async (spaceId) => {
      const [entry] = JSON.parse((await docker(['inspect', spaceResourceName(spaceId, ROLE_GATEKEEPER)])).stdout);
      const networks = entry.NetworkSettings.Networks;
      return {
        inner: networks[spaceResourceName(spaceId, ROLE_NETWORK)]?.IPAddress ?? '',
        outer: networks[spaceResourceName(spaceId, ROLE_OUTER_NETWORK)]?.IPAddress ?? '',
      };
    },

    /**
     * A stand-in model provider on the space's outer network, where a real one would be. It
     * answers with the sha256 of the credentials it saw, never with the credentials, so that a
     * test can prove the real key travelled without handing it to the space.
     */
    startWindowUpstream: async (spaceId) => {
      const name = `openchamber-test-upstream-${owner}`;
      const program = `
const crypto = require('node:crypto');
const hash = (value) => (value === undefined ? 'none' : 'sha256:' + crypto.createHash('sha256').update(String(value)).digest('hex'));
require('node:http').createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    path: request.url,
    authorization: hash(request.headers.authorization),
    apiKey: hash(request.headers['x-api-key']),
    headerNames: Object.keys(request.headers).sort(),
  }));
}).listen(9000, '0.0.0.0', () => console.log('upstream listening'));
`;
      await docker([
        'run', '--detach', '--name', name, ...helperLabels,
        '--network', spaceResourceName(spaceId, ROLE_OUTER_NETWORK), '--network-alias', 'upstream',
        SPACE_BASE_IMAGE, 'node', '-e', program,
      ], { timeoutMs: 120_000 });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 250); });
        if ((await docker(['logs', name])).stdout.includes('upstream listening')) break;
      }
      return { url: 'http://upstream:9000/v1', stop: () => docker(['rm', '--force', name]) };
    },

    /**
     * A name of our own in the space's outer network, answered by Docker's embedded resolver with
     * an address in that bridge's subnet — a private range, and therefore one the corridor must
     * refuse. It exists so that the resolve-then-refuse path can be proved live without a
     * third-party wildcard DNS service: when somebody else's resolver has a bad minute, a test
     * that leans on it reports an inconclusive run and proves nothing.
     */
    startBlockedName: async (spaceId) => {
      const name = `openchamber-test-blocked-${owner}`;
      // A last label that is not a number, because the corridor takes names and this one has to
      // get past the name rule to reach the address rule that is under test.
      const alias = 'blocked-by-address.test';
      const network = spaceResourceName(spaceId, ROLE_OUTER_NETWORK);
      await docker([
        'run', '--detach', '--name', name, ...helperLabels,
        '--network', network, '--network-alias', alias,
        SPACE_BASE_IMAGE, 'sleep', '3600',
      ], { timeoutMs: 120_000 });
      const [entry] = JSON.parse((await docker(['inspect', name])).stdout);
      return {
        alias,
        address: entry.NetworkSettings.Networks[network]?.IPAddress ?? '',
        stop: () => docker(['rm', '--force', name]),
      };
    },

    /** The names of this owner's volumes. */
    volumes: async () => (await docker([...LISTINGS[2], ...ownerFilter])).stdout.split('\n').filter(Boolean),

    logBytes: async (spaceId) => {
      const result = await docker(['logs', spaceResourceName(spaceId, ROLE_SPACE)], { maxOutputBytes: 128 * 1024 * 1024, timeoutMs: 120_000 });
      return Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    },
  };

  /** Removes every space, helper and tools volume of this run, then asserts that Docker holds nothing with this owner label. */
  const dispose = async () => {
    // Helpers first: one of them sits on a space's outer network, and a network with a
    // container on it cannot go.
    const spaces = new Set((await place.list()).flatMap((space) => [spaceResourceName(space.id, ROLE_SPACE), spaceResourceName(space.id, ROLE_GATEKEEPER)]));
    for (const helper of (await docker([...LISTINGS[0], ...ownerFilter])).stdout.split('\n').filter(Boolean)) {
      if (!spaces.has(helper)) await docker(['rm', '--force', helper]);
    }
    for (const space of await place.list()) {
      await place.remove(space.id);
    }
    for (const helper of (await docker([...LISTINGS[0], ...ownerFilter])).stdout.split('\n').filter(Boolean)) {
      await docker(['rm', '--force', helper]);
    }
    for (const network of (await docker([...LISTINGS[1], ...ownerFilter])).stdout.split('\n').filter(Boolean)) {
      await docker(['network', 'rm', network]);
    }
    // What is left now are the tools volumes. No space mounts them any more.
    for (const volume of await host.volumes()) {
      await docker(['volume', 'rm', volume]);
    }
    expect(await leftovers()).toEqual([]);
  };

  return { place, placeWith, dispose, host, owner };
}
