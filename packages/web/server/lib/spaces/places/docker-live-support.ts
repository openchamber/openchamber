
import crypto from 'node:crypto';

import { expect } from 'vitest';
import { z } from 'zod';

import { LABEL_MARKER, LABEL_OWNER, ROLE_GATEKEEPER, ROLE_NETWORK, ROLE_OUTER_NETWORK, ROLE_SPACE, spaceResourceName } from '../labels.js';
import type { CommandOptions } from '../command-contracts.js';
import { runCommand } from '../run-command.js';
import { createRegistryToolsSource, readHostToolVersions } from '../tools.js';
import type { ToolsSource } from '../tools.js';
import { SPACE_BASE_IMAGE, createDockerPlace } from './docker.js';
import { parseInspectOutput } from './docker-wire.js';

export const LIVE_DOCKER_ENABLED = process.env.OPENCHAMBER_TEST_DOCKER === '1';
const LIVE_DOCKER_HOST = process.env.OPENCHAMBER_TEST_DOCKER_HOST || null;

const LISTINGS = [
  ['ps', '--all', '--format', '{{.Names}}'],
  ['network', 'ls', '--format', '{{.Name}}'],
  ['volume', 'ls', '--format', '{{.Name}}'],
] as const;

const HOST_LISTENER = (port: number) => `
const routes = require('node:fs').readFileSync('/proc/net/fib_trie', 'utf8');
const local = [...routes.matchAll(/\\|-- (\\d+\\.\\d+\\.\\d+\\.\\d+)\\n\\s+\\/32 host LOCAL/g)].map((match) => match[1]);
const addresses = [...new Set(local)].filter((address) => !address.startsWith('127.'));
require('node:net').createServer((socket) => { socket.on('error', () => {}); socket.end('host'); }).listen(${port}, '0.0.0.0', () => console.log(JSON.stringify(addresses)));
`;

const listenerAddressesSchema = z.array(z.string());

export const parseListenerAddresses = (line: string) => (line.startsWith('[') ? listenerAddressesSchema.parse(JSON.parse(line)) : []);

export const upstreamSeenSchema = z.looseObject({
  method: z.string(),
  path: z.string(),
  authorization: z.string(),
  apiKey: z.string(),
  team: z.string(),
  headerNames: z.array(z.string()),
});

export const parseUpstreamLog = (log: string) => log.split('\n').filter((line) => line.startsWith('seen ')).map((line) => ({ ...upstreamSeenSchema.parse(JSON.parse(line.slice(5))), line }));

export function createLiveDockerPlace({ toolsSource = createRegistryToolsSource(readHostToolVersions()), dockerHost = LIVE_DOCKER_HOST }: { toolsSource?: ToolsSource; dockerHost?: string | null } = {}) {
  const owner = `test-${crypto.randomBytes(6).toString('hex')}`;
  const placeWith = (source: ToolsSource) => createDockerPlace({ runCommand, dockerPath: 'docker', dockerHost, owner, toolsSource: source });
  const place = placeWith(toolsSource);
  const ownerFilter = ['--filter', `label=${LABEL_MARKER}`, '--filter', `label=${LABEL_OWNER}=${owner}`];
  const helperLabels = ['--label', `${LABEL_MARKER}=true`, '--label', `${LABEL_OWNER}=${owner}`];

  const hostArgs = dockerHost === null ? [] : ['--host', dockerHost];
  const docker = async (args: string[], options?: CommandOptions) => {
    const result = await runCommand('docker', [...hostArgs, ...args], options);
    expect(result.code, `docker ${args[0]}: ${result.stderr}`).toBe(0);
    return result;
  };

  const networksOf = async (container: string) => {
    const [entry] = parseInspectOutput<'container'>((await docker(['inspect', container])).stdout);
    const networks = entry?.NetworkSettings?.Networks;
    if (!networks) throw new Error(`docker inspect printed no networks for ${container}`);
    return networks;
  };

  const leftovers = async () => {
    const names: string[] = [];
    for (const listing of LISTINGS) {
      names.push(...(await docker([...listing, ...ownerFilter])).stdout.split('\n').filter(Boolean));
    }
    return names;
  };

  const host = {
    runUnrestricted: (script: string) => docker(['run', '--rm', ...helperLabels, SPACE_BASE_IMAGE, 'node', '-e', script], { timeoutMs: 120_000 }),

    startHostListener: async () => {
      const port = 20_000 + crypto.randomInt(20_000);
      const name = `openchamber-test-listener-${owner}`;
      await docker(['run', '--detach', '--name', name, ...helperLabels, '--network', 'host', SPACE_BASE_IMAGE, 'node', '-e', HOST_LISTENER(port)], { timeoutMs: 120_000 });
      let addresses: string[] = [];
      for (let attempt = 0; attempt < 40 && addresses.length === 0; attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 250); });
        const [firstLine = ''] = (await docker(['logs', name])).stdout.split('\n');
        addresses = parseListenerAddresses(firstLine);
      }
      expect(addresses.length, 'the host listener reported no address').toBeGreaterThan(0);
      return { port, candidates: [...addresses, 'host.docker.internal', 'gateway.docker.internal'], stop: () => docker(['rm', '--force', name]) };
    },

    createPlainInternalNetwork: async () => {
      const name = `openchamber-test-plain-${owner}`;
      await docker(['network', 'create', '--driver', 'bridge', '--internal', '--ipv6=false', ...helperLabels, name]);
      return {
        run: (script: string) => docker(['run', '--rm', ...helperLabels, '--network', name, SPACE_BASE_IMAGE, 'node', '-e', script], { timeoutMs: 120_000 }),
        remove: () => docker(['network', 'rm', name]),
      };
    },

    spaceMetadata: async (spaceId: string) => (await docker(['inspect', spaceResourceName(spaceId, ROLE_SPACE)])).stdout,

    gatekeeperMetadata: async (spaceId: string) => (await docker(['inspect', spaceResourceName(spaceId, ROLE_GATEKEEPER)])).stdout,

    spaceAddress: async (spaceId: string) => (await networksOf(spaceResourceName(spaceId, ROLE_SPACE)))[spaceResourceName(spaceId, ROLE_NETWORK)]?.IPAddress ?? '',

    gatekeeperAddresses: async (spaceId: string) => {
      const networks = await networksOf(spaceResourceName(spaceId, ROLE_GATEKEEPER));
      return {
        inner: networks[spaceResourceName(spaceId, ROLE_NETWORK)]?.IPAddress ?? '',
        outer: networks[spaceResourceName(spaceId, ROLE_OUTER_NETWORK)]?.IPAddress ?? '',
      };
    },

    startWindowUpstream: async (spaceId: string) => {
      const name = `openchamber-test-upstream-${owner}`;
      const program = `
const crypto = require('node:crypto');
const hash = (value) => (value === undefined ? 'none' : 'sha256:' + crypto.createHash('sha256').update(String(value)).digest('hex'));
require('node:http').createServer((request, response) => {
  const seen = {
    method: request.method,
    path: request.url,
    authorization: hash(request.headers.authorization),
    apiKey: hash(request.headers['x-api-key']),
    // A header of the user's own, as a custom provider's grant sets it beside the key.
    team: hash(request.headers['x-team']),
    headerNames: Object.keys(request.headers).sort(),
  };
  // One line per request in the container's log, so the host can read what a client it does
  // not control, OpenCode inside a space, sent here. Hashes only, as in the answer.
  console.log('seen ' + JSON.stringify(seen));
  // GitHub Copilot's plugin in OpenCode asks for the model list before any turn and takes it in
  // GitHub's own shape only: one model, enough for a turn to go through the window.
  const models = request.method === 'GET' && request.url.split('?')[0].endsWith('/models');
  const body = models
    ? { data: [{ model_picker_enabled: true, id: 'gpt-4o', name: 'GPT-4o', version: 'gpt-4o-2024-11-20', capabilities: { family: 'gpt-4o', limits: { max_output_tokens: 4096, max_prompt_tokens: 64000 }, supports: { tool_calls: true, streaming: true } } }] }
    : seen;
  request.resume();
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
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
      return {
        url: 'http://upstream:9000/v1',
        seen: async () => parseUpstreamLog((await docker(['logs', name])).stdout),
        stop: () => docker(['rm', '--force', name]),
      };
    },

    connectWindowUpstream: (spaceId: string) => docker(['network', 'connect', '--alias', 'upstream', spaceResourceName(spaceId, ROLE_OUTER_NETWORK), `openchamber-test-upstream-${owner}`]),

    probeFromOuterNetwork: (spaceId: string, script: string) => docker(
      ['run', '--rm', ...helperLabels, '--network', spaceResourceName(spaceId, ROLE_OUTER_NETWORK), SPACE_BASE_IMAGE, 'node', '-e', script],
      { timeoutMs: 120_000 },
    ),

    startBlockedName: async (spaceId: string) => {
      const name = `openchamber-test-blocked-${owner}`;
      const alias = 'blocked-by-address.test';
      const network = spaceResourceName(spaceId, ROLE_OUTER_NETWORK);
      await docker([
        'run', '--detach', '--name', name, ...helperLabels,
        '--network', network, '--network-alias', alias,
        SPACE_BASE_IMAGE, 'sleep', '3600',
      ], { timeoutMs: 120_000 });
      const networks = await networksOf(name);
      return {
        alias,
        address: networks[network]?.IPAddress ?? '',
        stop: () => docker(['rm', '--force', name]),
      };
    },

    volumes: async () => (await docker([...LISTINGS[2], ...ownerFilter])).stdout.split('\n').filter(Boolean),

    logBytes: async (spaceId: string) => {
      const result = await docker(['logs', spaceResourceName(spaceId, ROLE_SPACE)], { maxOutputBytes: 128 * 1024 * 1024, timeoutMs: 120_000 });
      return Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    },
  };

  const dispose = async () => {
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
    for (const volume of await host.volumes()) {
      await docker(['volume', 'rm', volume]);
    }
    expect(await leftovers()).toEqual([]);
  };

  return { place, placeWith, dispose, host, owner };
}
