import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CommandResult } from '../command-contracts.js';
import { createGatekeeperChannel } from '../gatekeeper-channel.js';
import { createSpaceId, hashProjectDirectory } from '../labels.js';
import {
  GATEKEEPER_ALIAS,
  GATEKEEPER_CONTROL_PORT,
  GATEKEEPER_CORRIDOR_PORT,
  GATEKEEPER_WINDOW_PORT,
  SPACE_HOME,
  SPACE_SERVER_PORT,
  TOOLS_BIN_PATH,
  TOOLS_MARKER_PATH,
  TOOLS_MOUNT_PATH,
} from '../layout.js';
import { createSpaceServerChannel } from '../space-server.js';
import type { ContractPlace } from './contract-suite.js';
import { upstreamSeenSchema } from './docker-live-support.js';
import type { parseUpstreamLog } from './docker-live-support.js';
import { parseIntegrationConnections, parsePluginList, sessionCookieOf } from './escape-answers.js';

interface HostListener {
  port: number;
  candidates: string[];
  stop: () => Promise<CommandResult | void>;
}

interface WindowUpstream {
  url: string;
  seen: () => Promise<ReturnType<typeof parseUpstreamLog>>;
  stop: () => Promise<CommandResult | void>;
}

export interface EscapeHost {
  runUnrestricted: (script: string) => Promise<CommandResult>;
  startHostListener: () => Promise<HostListener>;
  createPlainInternalNetwork: () => Promise<{ run: (script: string) => Promise<CommandResult>; remove: () => Promise<CommandResult> }>;
  logBytes: (spaceId: string) => Promise<number>;
  spaceMetadata: (spaceId: string) => Promise<string>;
  gatekeeperMetadata: (spaceId: string) => Promise<string>;
  spaceAddress: (spaceId: string) => Promise<string>;
  gatekeeperAddresses: (spaceId: string) => Promise<{ inner: string; outer: string }>;
  probeFromOuterNetwork: (spaceId: string, script: string) => Promise<CommandResult>;
  startWindowUpstream: (spaceId: string) => Promise<WindowUpstream>;
  startBlockedName: (spaceId: string) => Promise<{ alias: string; address: string; stop: () => Promise<CommandResult> }>;
}

export interface EscapeSuiteOptions {
  enabled?: boolean;
  setup: () => Promise<{ place: ContractPlace; dispose: () => Promise<void>; host: EscapeHost }>;
}

const probeAnswersSchema = z.record(z.string(), z.string().regex(/^(?:connected:.+|failed:.*)$/));
export const parseProbeAnswers = (stdout: string) => probeAnswersSchema.parse(JSON.parse(stdout));

export const parseWindowSeen = (answer: string) => upstreamSeenSchema.parse(JSON.parse(answer.slice(4)));

const TUNNEL_ATTEMPTS = 80;
const tunnelCount = z.number().int().nonnegative();
const tunnelCountsSchema = z.object({ established: tunnelCount, refused: tunnelCount, unreachable: tunnelCount, failed: tunnelCount })
  .refine((counts) => counts.established + counts.refused + counts.unreachable + counts.failed === TUNNEL_ATTEMPTS, `the counts do not add up to ${TUNNEL_ATTEMPTS} attempts`);
export const parseTunnelCounts = (answer: string) => {
  if (!answer.startsWith('done:')) throw new Error(`The tunnel probe did not finish: ${answer}`);
  return tunnelCountsSchema.parse(JSON.parse(answer.slice('done:'.length)));
};

const CREATE_TIMEOUT_MS = 25 * 60_000;
const MEMORY_BYTES = 1024 * 1024 * 1024;
const LOG_CAP_BYTES = 11 * 1024 * 1024;

const PROBE_HEAD = "const done = (text) => { console.log(text); process.exit(0); };";

const tcpProbe = (host: string, port: number) => `${PROBE_HEAD}
const socket = require('node:net').connect({ host: '${host}', port: ${port} });
socket.setTimeout(4000, () => done('failed:timeout'));
socket.on('connect', () => done('connected:' + socket.remoteAddress));
socket.on('error', (error) => done('failed:' + error.code));
`;

const hostProbe = (candidates: string[], port: number) => `
const net = require('node:net');
const attempt = (host) => new Promise((resolve) => {
  const socket = net.connect({ host, port: ${port} });
  const done = (text) => { socket.destroy(); resolve([host, text]); };
  socket.setTimeout(4000, () => done('failed:timeout'));
  socket.on('connect', () => done('connected:' + socket.remoteAddress));
  socket.on('error', (error) => done('failed:' + error.code));
});
Promise.all(${JSON.stringify(candidates)}.map(attempt)).then((answers) => { console.log(JSON.stringify(Object.fromEntries(answers))); process.exit(0); });
`;

const DNS_PROBE = `${PROBE_HEAD}
setTimeout(() => done('failed:timeout'), 5000);
require('node:dns').promises.lookup('example.com').then(
  (answer) => done('resolved:' + answer.address),
  (error) => done('failed:' + error.code),
);
`;

const INTERNET_BASELINE = `${PROBE_HEAD}
setTimeout(() => done('failed:timeout'), 9000);
require('node:dns').promises.lookup('example.com', { family: 4 }).then(({ address }) => {
  const socket = require('node:net').connect({ host: address, port: 443 });
  socket.on('connect', () => done('connected:' + address));
  socket.on('error', (error) => done('failed:' + error.code));
}, (error) => done('failed:' + error.code));
`;

const LISTENERS = "cat /proc/net/tcp /proc/net/tcp6 | awk '$4 == \"0A\" { print $2 }'";
const LOOPBACK_LISTENER = /^([0-9A-F]{6}7F|00000000000000000000000001000000):[0-9A-F]{4}$/;

const ALLOCATE_WITHOUT_END = 'const kept = []; for (;;) kept.push(Buffer.alloc(16 * 1024 * 1024, 1));';

const corridorProbe = (target: string) => `${PROBE_HEAD}
const socket = require('node:net').connect({ host: '${GATEKEEPER_ALIAS}', port: ${GATEKEEPER_CORRIDOR_PORT} });
let answer = '';
socket.setTimeout(20000, () => done('failed:timeout'));
socket.on('connect', () => socket.write('CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n\\r\\n'));
socket.on('data', (chunk) => { answer += chunk; if (answer.includes('\\r\\n')) done('answer:' + answer.split('\\r\\n')[0]); });
socket.on('error', (error) => done('failed:' + error.code));
`;

const windowProbe = (path: string, headers: Record<string, string> = {}) => `${PROBE_HEAD}
const request = require('node:http').request({
  host: '${GATEKEEPER_ALIAS}', port: ${GATEKEEPER_WINDOW_PORT}, path: ${JSON.stringify(path)}, method: 'GET', headers: ${JSON.stringify(headers)},
}, (answer) => {
  let body = '';
  answer.on('data', (chunk) => { body += chunk; });
  answer.on('end', () => done(answer.statusCode + ' ' + body.slice(0, 2000)));
});
request.on('error', (error) => done('failed:' + error.code));
setTimeout(() => done('failed:timeout'), 25000);
request.end();
`;

const ABUSE = `${PROBE_HEAD}
const net = require('node:net');
const lines = [
  'CONNECT', 'CONNECT :443 HTTP/1.1', 'CONNECT example.com: HTTP/1.1', 'CONNECT [::1:443 HTTP/1.1',
  'GET / HTTP/1.1', 'x'.repeat(40000), 'CONNECT example.com:443 HTTP/1.1\\r\\nX-Filler: ' + 'a'.repeat(100000),
];
const send = (line, reset) => new Promise((resolve) => {
  const socket = net.connect({ host: '${GATEKEEPER_ALIAS}', port: ${GATEKEEPER_CORRIDOR_PORT} });
  socket.on('error', () => resolve());
  socket.setTimeout(3000, () => { socket.destroy(); resolve(); });
  socket.on('connect', () => { socket.write(line + '\\r\\n\\r\\n'); if (reset) socket.resetAndDestroy(); });
  socket.on('close', () => resolve());
  socket.on('data', () => { socket.destroy(); resolve(); });
});
const work = [];
for (let round = 0; round < 12; round += 1) {
  for (const line of lines) work.push(send(line, false), send(line, true));
}
Promise.all(work).then(() => done('done:' + work.length));
`;

const FLOOD = `${PROBE_HEAD}
const net = require('node:net');
const kept = [];
const open = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '${GATEKEEPER_ALIAS}', port });
  socket.on('error', () => resolve());
  socket.on('connect', () => { kept.push(socket); resolve(); });
  socket.on('close', () => resolve());
  setTimeout(resolve, 5000);
});
const work = [];
for (let attempt = 0; attempt < 400; attempt += 1) {
  work.push(open(${GATEKEEPER_CORRIDOR_PORT}), open(${GATEKEEPER_WINDOW_PORT}), open(${GATEKEEPER_CONTROL_PORT}));
}
Promise.all(work).then(() => { const held = kept.length; for (const socket of kept) socket.destroy(); setTimeout(() => done('done:' + held), 500); });
`;

const HOLD_TUNNELS = `${PROBE_HEAD}
const net = require('node:net');
const kept = [];
const attempt = () => new Promise((resolve) => {
  const socket = net.connect({ host: '${GATEKEEPER_ALIAS}', port: ${GATEKEEPER_CORRIDOR_PORT} });
  let answer = '';
  const end = (outcome) => resolve(outcome);
  socket.on('error', () => end('failed'));
  socket.setTimeout(20000, () => { socket.destroy(); end('failed'); });
  socket.on('connect', () => socket.write('CONNECT example.com:443 HTTP/1.1\\r\\n\\r\\n'));
  socket.on('data', (chunk) => {
    answer += chunk;
    if (!answer.includes('\\r\\n')) return;
    if (answer.startsWith('HTTP/1.1 200')) { kept.push(socket); end('established'); return; }
    socket.destroy();
    // A 502 means the corridor allowed it and the connection out failed, which is the machine
    // and not the cap. The test says so instead of reading it as a refusal.
    end(answer.startsWith('HTTP/1.1 502') ? 'unreachable' : 'refused');
  });
});
Promise.all(Array.from({ length: ${TUNNEL_ATTEMPTS} }, attempt)).then((outcomes) => {
  const counts = { established: 0, refused: 0, unreachable: 0, failed: 0 };
  for (const outcome of outcomes) counts[outcome] += 1;
  for (const socket of kept) socket.destroy();
  setTimeout(() => done('done:' + JSON.stringify(counts)), 1000);
});
`;

const LONG_LIVED_CREDENTIAL = '"refresh"[[:space:]]*:[[:space:]]*"|BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{16}|sk-[A-Za-z0-9_-]{20}|xox[baprs]-';

const credentialSearch = (spaceId: string) => `
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin;
echo "auth-record: $([ -e "$HOME/.local/share/opencode/auth.json" ] && echo present || echo absent)";
echo "--- files";
grep -raosE '${LONG_LIVED_CREDENTIAL}' "$HOME" /tmp /spaces/${spaceId} 2>/dev/null | head -20;
echo "--- environments";
for process in /proc/[0-9]*/environ; do tr '\\0' '\\n' < "$process" 2>/dev/null; done | grep -E '${LONG_LIVED_CREDENTIAL}' | head -20;
echo "--- end";
`;

const DECOY_CREDENTIAL_ID = 'cred_decoy000000000000000000';
const DECOY_CUSTOM_CREDENTIAL_ID = 'cred_decoy000000000000000001';
const openDatabase = (databasePath: string, options = '{ timeout: 5000 }') => `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(${JSON.stringify(databasePath)}, ${options});
`;
const plantCredential = (databasePath: string) => `${openDatabase(databasePath)}
const now = Date.now();
const insert = db.prepare('INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)');
insert.run('${DECOY_CREDENTIAL_ID}', 'openai', 'default', JSON.stringify({ type: 'oauth', methodID: 'chatgpt-browser', refresh: 'decoy-refresh-value', access: 'decoy-access-value', expires: now + 3600000 }), 1, now, now);
insert.run('${DECOY_CUSTOM_CREDENTIAL_ID}', 'acme-llm', 'default', JSON.stringify({ type: 'key', key: 'acme_live_decoy' }), 1, now, now);
db.close();
`;
const removeCredential = (databasePath: string) => `${openDatabase(databasePath)}
const { changes } = db.prepare('DELETE FROM credential WHERE id IN (?, ?)').run('${DECOY_CREDENTIAL_ID}', '${DECOY_CUSTOM_CREDENTIAL_ID}');
db.close();
console.log('removed:' + changes);
`;
const readCredentials = (databasePath: string) => `${openDatabase(databasePath, '{ readOnly: true, timeout: 5000 }')}
const rows = db.prepare("SELECT integration_id AS integration, json_extract(value, '$.type') AS type FROM credential ORDER BY id").all();
db.close();
console.log(JSON.stringify(rows.map((row) => ({ integration: row.integration, type: row.type }))));
`;

const sleep = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });

const sha256 = (value: string) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

export function runEscapeSuite(title: string, { enabled = true, setup }: EscapeSuiteOptions) {
  describe.skipIf(!enabled)(`escape tests: ${title}`, () => {
    const spec = {
      id: createSpaceId(),
      name: 'Escape tests',
      project: hashProjectDirectory('/escape/suite/project'),
      created: new Date().toISOString(),
      memoryBytes: MEMORY_BYTES,
    };
    let place: ContractPlace;
    let host: EscapeHost;
    let dispose = async () => {};
    let internetBaseline = 'not run';

    const inside = (argv: string[]) => place.exec(spec.id, argv, { timeoutMs: 60_000 });
    const shell = (script: string) => inside(['sh', '-c', script]);

    const publicAddress = () => {
      const address = internetBaseline.replace(/^connected:/, '').trim();
      if (!internetBaseline.startsWith('connected:') || net.isIP(address) === 0) {
        throw new Error(`Inconclusive: a container with normal networking could not reach example.com:443 (${internetBaseline.trim()}), so a failure inside the space proves nothing. Check the internet connection of the Docker machine.`);
      }
      return address;
    };

    beforeAll(async () => {
      ({ place, dispose, host } = await setup());
      await place.create(spec);
      internetBaseline = (await host.runUnrestricted(INTERNET_BASELINE)).stdout;
    }, CREATE_TIMEOUT_MS);

    afterAll(async () => {
      await dispose();
    });

    it('positive control: can write inside the space directory, HOME and /tmp', async () => {
      const work = await shell(`echo kept > /spaces/${spec.id}/probe && cat /spaces/${spec.id}/probe`);
      expect(work).toMatchObject({ code: 0, stdout: 'kept\n' });

      const home = await shell('echo kept > "$HOME/probe" && cat "$HOME/probe" && echo "$HOME"');
      expect(home).toMatchObject({ code: 0, stdout: 'kept\n/home/space\n' });

      const tmp = await shell('echo kept > /tmp/probe && cat /tmp/probe');
      expect(tmp).toMatchObject({ code: 0, stdout: 'kept\n' });
    });

    it('is not root and cannot become root', async () => {
      expect((await inside(['id', '-u'])).stdout).toBe('1000\n');

      const sudo = await shell('sudo -n id -u');
      expect(sudo.code).not.toBe(0);
      expect(sudo.stdout.trim()).not.toBe('0');

      const su = await shell('su root -c "id -u" </dev/null');
      expect(su.code).not.toBe(0);
      expect(su.stdout).toBe('');
    });

    it('has no capabilities and cannot gain privileges', async () => {
      const status = (await inside(['cat', '/proc/self/status'])).stdout;
      expect(status).toMatch(/^NoNewPrivs:\s+1$/m);
      expect(status).toMatch(/^CapEff:\s+0000000000000000$/m);
      expect(status).toMatch(/^CapPrm:\s+0000000000000000$/m);
      expect(status).toMatch(/^Seccomp:\s+2$/m);
    });

    it('cannot make a user namespace where it would be root', async () => {
      expect((await shell('command -v unshare')).code).toBe(0);
      const result = await inside(['unshare', '-Ur', 'id', '-u']);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
    });

    it('cannot mount a filesystem', async () => {
      expect((await shell('command -v mount')).code).toBe(0);
      const result = await inside(['mount', '-t', 'tmpfs', 'none', '/mnt']);
      expect(result.code).not.toBe(0);
    });

    it('cannot change kernel settings', async () => {
      expect((await inside(['cat', '/proc/sys/kernel/hostname'])).code).toBe(0);
      const result = await shell('echo escaped > /proc/sys/kernel/hostname');
      expect(result.code).not.toBe(0);
      expect((await inside(['cat', '/proc/sys/kernel/hostname'])).stdout).not.toContain('escaped');
    });

    it.each(['/', '/etc', '/usr'])('cannot write to %s', async (directory: string) => {
      const result = await shell(`touch ${directory}/openchamber-escape-probe`);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/Read-only file system|Permission denied/);
    });

    it.each(['/var/run/docker.sock', '/run/docker.sock'])('has no runtime socket at %s', async (socketPath: string) => {
      expect((await inside(['test', '-e', socketPath])).code).not.toBe(0);
      expect((await inside(['test', '-e', '/etc/passwd'])).code).toBe(0);
    });

    it('cannot open a TCP connection to the internet', async () => {
      const result = await inside(['node', '-e', tcpProbe(publicAddress(), 443)]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^failed:/);
    });

    it('cannot resolve a public name', async () => {
      publicAddress();
      const result = await inside(['node', '-e', DNS_PROBE]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^failed:/);
    });

    it('cannot reach a service that listens on the host of the place', async () => {
      const plain = await host.createPlainInternalNetwork();
      let listener: HostListener = { port: 0, candidates: [], stop: async () => {} };
      try {
        listener = await host.startHostListener();
        const { port, candidates } = listener;
        const connected = (answers: Record<string, string>) => Object.entries(answers).filter(([, answer]) => answer.startsWith('connected:'));
        const probe = async (run: (script: string) => Promise<CommandResult>) => parseProbeAnswers((await run(hostProbe(candidates, port))).stdout);

        let fromOutside: Record<string, string> = {};
        for (let attempt = 0; attempt < 20 && connected(fromOutside).length === 0; attempt += 1) {
          await sleep(250);
          fromOutside = await probe(host.runUnrestricted);
        }
        if (connected(fromOutside).length === 0) {
          throw new Error(`Inconclusive: a container with normal networking reached the host listener through none of ${candidates.join(', ')}.`);
        }

        const fromPlain = await probe(plain.run);
        if (connected(fromPlain).length === 0) {
          throw new Error(`Inconclusive: from a plain internal network no host address connected (${JSON.stringify(fromPlain)}), so this probe cannot show the hole and a failure inside the space proves nothing.`);
        }

        const reached = [...connected(fromOutside), ...connected(fromPlain)].map(([, answer]) => answer.replace(/^connected:/, ''));
        const targets = [...new Set([...candidates, ...reached.filter((address) => net.isIP(address) !== 0)])];
        const { inner } = await host.gatekeeperAddresses(spec.id);
        expect(targets, `the gatekeeper's own address ${inner} is not a host address`).not.toContain(inner);
        const result = await inside(['node', '-e', hostProbe(targets, port)]);
        expect(result.code).toBe(0);
        const fromSpace = parseProbeAnswers(result.stdout);
        expect(Object.keys(fromSpace)).toEqual(targets);
        expect(connected(fromSpace), JSON.stringify(fromSpace)).toEqual([]);
      } finally {
        await listener.stop();
        await plain.remove();
      }
    }, 180_000);

    it('sees no host path in its mounts', async () => {
      const result = await inside(['mount']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`/spaces/${spec.id}`);

      const hostUser = os.userInfo().username;
      for (const hostPath of ['/Users', `/home/${hostUser}`, '/host', '/mnt/host', 'docker.sock']) {
        const asPathSegment = new RegExp(`${hostPath.replace(/[.]/g, '\\.')}(/|\\s|$)`, 'm');
        expect(result.stdout).not.toMatch(asPathSegment);
      }
    });

    describe('tools volume', () => {
      const launcher = `${TOOLS_BIN_PATH}/openchamber`;
      const fingerprint = async () => (await shell(`sha256sum ${TOOLS_MARKER_PATH} "$(readlink -f ${launcher})" && ls -la ${TOOLS_MOUNT_PATH} ${TOOLS_BIN_PATH}`)).stdout;

      it('positive control: the tools are there, and the programs the space runs come from them', async () => {
        const version = await inside(['openchamber', '--version']);
        expect(version.code).toBe(0);
        expect(version.stdout).toMatch(/^\d+\.\d+\.\d+/);
        expect((await shell('command -v openchamber && command -v opencode')).stdout).toBe(`${launcher}\n${TOOLS_BIN_PATH}/opencode\n`);

        const running = (await shell("for pid in /proc/[0-9]*; do tr '\\0' ' ' < $pid/cmdline; echo; done")).stdout;
        expect(running).toMatch(new RegExp(`node ${launcher} serve --foreground`));
        expect(running).toMatch(new RegExp(`${TOOLS_MOUNT_PATH}/node_modules/\\S*opencode\\S* serve`));
      });

      it('is mounted read-only', async () => {
        const mounts = (await inside(['cat', '/proc/mounts'])).stdout.split('\n').filter((line) => line.split(' ')[1] === TOOLS_MOUNT_PATH);
        expect(mounts).toHaveLength(1);
        const [mount = ''] = mounts;
        const [, , , options = ''] = mount.split(' ');
        expect(options.split(',')).toContain('ro');
      });

      it.each([
        ['write a new file', `touch ${TOOLS_MOUNT_PATH}/openchamber-escape-probe`],
        ['write into node_modules', `touch ${TOOLS_BIN_PATH}/openchamber-escape-probe`],
        ['overwrite the launcher', `echo 'echo escaped' > "$(readlink -f ${launcher})"`],
        ['replace the launcher', `cp /bin/true /tmp/replacement && mv /tmp/replacement ${launcher}`],
        ['replace the launcher with a link', `ln -sfn /bin/true ${launcher}`],
        ['delete the launcher', `rm -f ${launcher}`],
        ['delete the fill marker', `rm -f ${TOOLS_MARKER_PATH}`],
        ['rename a directory', `mv ${TOOLS_MOUNT_PATH}/node_modules ${TOOLS_MOUNT_PATH}/node_modules-moved`],
        ['change permissions', `chmod 777 ${TOOLS_MOUNT_PATH}`],
        ['change permissions of the launcher', `chmod 777 "$(readlink -f ${launcher})"`],
      ])('cannot %s', async (_title: string, script: string) => {
        const before = await fingerprint();
        expect(before).toMatch(/^[0-9a-f]{64} {2}/);

        const result = await shell(script);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toMatch(/Read-only file system/);
        expect(result.stderr).not.toMatch(/Permission denied|Operation not permitted/);
        expect(await fingerprint()).toBe(before);
      });

      it('cannot append to the launcher', async () => {
        const before = await fingerprint();
        const result = await shell(`echo 'echo escaped' >> "$(readlink -f ${launcher})"`);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toMatch(/Permission denied|Read-only file system/);
        expect(await fingerprint()).toBe(before);
      });

      it('cannot remount it writable', async () => {
        expect((await shell('command -v mount')).code).toBe(0);
        const result = await inside(['mount', '-o', 'remount,rw', TOOLS_MOUNT_PATH]);
        expect(result.code).not.toBe(0);
        expect((await shell(`touch ${TOOLS_MOUNT_PATH}/openchamber-escape-probe`)).code).not.toBe(0);
      });
    });

    it('keeps the server token out of everything the place records about the container', async () => {
      const server = createSpaceServerChannel({ exec: place.exec });
      const token = await server.readToken(spec.id);
      expect(token.length).toBeGreaterThanOrEqual(32);
      const login = (password: string) => server.request(spec.id, { method: 'POST', path: '/auth/session', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      expect((await login(token)).status).toBe(200);
      expect((await login(`${token}x`)).status).toBe(401);

      const metadata = await host.spaceMetadata(spec.id);
      expect(metadata).toContain('OPENCODE_DISABLE_AUTOUPDATE=1');
      expect(metadata).not.toContain(token);
    });

    it('cannot steer the requests of the host through its own ~/.curlrc', async () => {
      const server = createSpaceServerChannel({ exec: place.exec });
      try {
        await shell(`printf 'write-out = "INJECTED-BY-THE-AGENT"\\n' > "$HOME/.curlrc"`);
        const unprotected = await shell(`curl --silent http://127.0.0.1:${SPACE_SERVER_PORT}/health`);
        expect(unprotected.stdout).toContain('INJECTED-BY-THE-AGENT');

        const answer = await server.request(spec.id, { path: '/health' });
        expect(answer.status).toBe(200);
        expect(answer.body).not.toContain('INJECTED-BY-THE-AGENT');
        expect(JSON.parse(answer.body)).toMatchObject({ isOpenCodeReady: true });
      } finally {
        await shell('rm -f "$HOME/.curlrc"');
      }
    });

    it('has no listener that faces the space network', async () => {
      const listeners = (await shell(LISTENERS)).stdout.split('\n').filter(Boolean);
      expect(listeners).toContain(`0100007F:${SPACE_SERVER_PORT.toString(16).toUpperCase().padStart(4, '0')}`);
      expect(listeners.filter((listener) => !LOOPBACK_LISTENER.test(listener))).toEqual([]);
    });

    it('cannot fill the disk of the host through its own output', async () => {
      const flood = await shell('head -c 52428800 /dev/zero | tr "\\0" x | fold -w 1000 > /proc/1/fd/1');
      expect(flood.code).toBe(0);
      const kept = await host.logBytes(spec.id);
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(LOG_CAP_BYTES);
    }, 120_000);

    describe('gatekeeper', () => {
      const MODEL_KEY = `sk-live-${crypto.randomBytes(24).toString('hex')}`;
      const channel = () => createGatekeeperChannel({ exec: place.exec });
      const probe = async (script: string) => {
        const result = await inside(['node', '-e', script]);
        expect(result.code, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      const inGatekeeper = (argv: string[]) => place.exec(spec.id, argv, { timeoutMs: 60_000, target: 'gatekeeper' });

      const mustCarry = async (target: string) => {
        const answer = await probe(corridorProbe(target));
        if (/^answer:HTTP\/1\.1 502 /.test(answer)) {
          throw new Error(`Inconclusive: the corridor allowed ${target} and the Docker machine could not reach it (${answer}). While that is true, what is refused below says nothing about the restriction.`);
        }
        expect(answer, target).toMatch(/^answer:HTTP\/1\.1 200 /);
        return answer;
      };
      const allow = (domains: string[]) => channel().setNetwork(spec.id, { mode: 'allowlist', domains });
      const open = () => channel().setNetwork(spec.id, { mode: 'open', domains: [] });
      const journalMark = async () => {
        const { records, dropped } = await channel().readJournal(spec.id);
        return records.length + dropped;
      };

      const decisionFor = async (host: string, mark = 0) => {
        const { records, dropped } = await channel().readJournal(spec.id);
        const since = Math.max(0, records.length + dropped - mark);
        const fresh = records.slice(Math.max(0, records.length - since)).filter((entry) => entry.host === host);
        expect(fresh.length, `the gatekeeper decided nothing about ${host}`).toBeGreaterThan(0);
        const [last] = fresh.slice(-1);
        if (last === undefined) throw new Error(`the gatekeeper decided nothing about ${host}`);
        return last;
      };

      it('positive control: the corridor carries what the host allowed, and refuses everything else', async () => {
        publicAddress();
        await allow(['example.com']);

        await mustCarry('example.com:443');
        expect(await probe(corridorProbe('example.org:443'))).toMatch(/^answer:HTTP\/1\.1 403 /);
        expect((await decisionFor('example.org')).decision).toBe('deny:not-on-allowlist');
        await allow(['example.org']);
        await mustCarry('example.org:443');
        expect(await probe(corridorProbe('example.com:443'))).toMatch(/^answer:HTTP\/1\.1 403 /);
      }, 120_000);


      it('cannot reach auth.openai.com in allowlist mode, even with it on the list', async () => {
        await allow(['auth.openai.com', 'example.com']);
        expect(await probe(corridorProbe('auth.openai.com:443'))).toMatch(/^answer:HTTP\/1\.1 403 /);
        expect((await decisionFor('auth.openai.com')).decision).toBe('deny:always-refused');
      }, 120_000);

      it('is refused for the name and for the address of auth.openai.com in open mode, which is a lock and not a guarantee', async () => {
        await open();
        expect(await probe(corridorProbe('auth.openai.com:443'))).toMatch(/^answer:HTTP\/1\.1 403 /);
        expect((await decisionFor('auth.openai.com')).decision).toBe('deny:always-refused');
      }, 120_000);

      it('refuses the address of a refused name as well, in either mode', async () => {
        const answers = await dns.lookup('auth.openai.com', { all: true, family: 4 }).catch(() => []);
        if (answers.length === 0) {
          throw new Error('Inconclusive: auth.openai.com did not resolve here, so the address form cannot be tried.');
        }
        const [first] = answers;
        if (first === undefined) {
          throw new Error('Inconclusive: auth.openai.com did not resolve here, so the address form cannot be tried.');
        }
        const { address } = first;
        const octets = address.split('.').map(Number);
        const [octet0 = 0, octet1 = 0, octet2 = 0, octet3 = 0] = octets;
        const asInteger = ((octet0 * 256 + octet1) * 256 + octet2) * 256 + octet3;
        const targets = [
          `${address}:443`,
          `${address}:8443`,
          `[::ffff:${address}]:443`,
          `[2002:${octets.slice(0, 2).map((part) => part.toString(16).padStart(2, '0')).join('')}:0::1]:443`,
          `${asInteger}:443`,
          `0x${asInteger.toString(16).padStart(8, '0')}:443`,
          `${octet0}.${octet1}.${octet2 * 256 + octet3}:443`,
        ];

        for (const change of [() => allow(['auth.openai.com', 'example.com']), open]) {
          await change();
          for (const target of targets) {
            expect(await probe(corridorProbe(target)), target).toMatch(/^answer:HTTP\/1\.1 403 /);
          }
          expect((await decisionFor(address)).decision).toBe('deny:not-a-name');
        }

        const reached = (await inGatekeeper(['node', '-e', tcpProbe(address, 443)])).stdout.trim();
        if (!reached.startsWith('connected:')) {
          throw new Error(`Inconclusive: the gatekeeper could not reach ${address} either (${reached}).`);
        }
      }, 180_000);

      it('reaches an allowed name on 443 and on no other port, in either mode', async () => {
        publicAddress();
        for (const change of [() => allow(['example.com']), open]) {
          await change();
          await mustCarry('example.com:443');
          for (const port of [80, 22, 8443]) {
            const at = await journalMark();
            expect(await probe(corridorProbe(`example.com:${port}`)), String(port)).toMatch(/^answer:HTTP\/1\.1 403 /);
            expect((await decisionFor('example.com', at)).decision).toBe('deny:port');
          }
        }
      }, 180_000);

      it('cannot ask the corridor for the Docker host, by address or by the names Docker injects', async () => {
        const listener = await host.startHostListener();
        try {
          const { port, candidates } = listener;
          const addresses = candidates.filter((candidate) => net.isIP(candidate) !== 0);

          const fromGatekeeper = parseProbeAnswers((await inGatekeeper(['node', '-e', hostProbe(candidates, port)])).stdout);
          const reached = Object.entries(fromGatekeeper).filter(([, answer]) => answer.startsWith('connected:'));
          if (reached.length === 0) {
            throw new Error(`Inconclusive: the gatekeeper reached the host through none of ${candidates.join(', ')} (${JSON.stringify(fromGatekeeper)}), so a refusal proves nothing.`);
          }

          for (const change of [() => allow(['example.com']), open]) {
            await change();
            for (const address of addresses) {
              expect(await probe(corridorProbe(`${address}:443`)), address).toMatch(/^answer:HTTP\/1\.1 403 /);
              expect(await probe(corridorProbe(`${address}:${port}`)), address).toMatch(/^answer:HTTP\/1\.1 403 /);
            }
            for (const address of addresses) {
              expect(await probe(corridorProbe(`[::ffff:${address}]:443`)), address).toMatch(/^answer:HTTP\/1\.1 403 /);
            }
            for (const name of candidates.filter((candidate) => net.isIP(candidate) === 0)) {
              expect(await probe(corridorProbe(`${name}:443`)), name).toMatch(/^answer:HTTP\/1\.1 403 /);
            }
          }
        } finally {
          await listener.stop();
        }
      }, 300_000);

      it('cannot reach a private address through the corridor by a name that resolves to it', async () => {
        publicAddress();
        const blocked = await host.startBlockedName(spec.id);
        try {
          expect(blocked.address, 'the helper container has no address on the outer network').toMatch(/^\d+\.\d+\.\d+\.\d+$/);
          const isPrivate = /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(blocked.address);
          if (!isPrivate) {
            throw new Error(`Inconclusive: this Docker daemon put the helper on ${blocked.address}, which is not a range the corridor refuses, so the address rule cannot be shown this way here.`);
          }
          for (const change of [() => allow([blocked.alias]), open]) {
            await change();
            const at = await journalMark();
            expect(await probe(corridorProbe(`${blocked.alias}:443`))).toMatch(/^answer:HTTP\/1\.1 403 /);
            expect((await decisionFor(blocked.alias, at)).decision).toBe('deny:blocked-address');
          }
        } finally {
          await blocked.stop();
        }
      }, 240_000);

      it('cannot reach the control channel of its own gatekeeper, on any address it has', async () => {
        const addresses = await host.gatekeeperAddresses(spec.id);
        expect(addresses.inner, 'the gatekeeper has no address on the inner network').toMatch(/\d+\.\d+\.\d+\.\d+/);

        expect(await probe(tcpProbe(GATEKEEPER_ALIAS, GATEKEEPER_CORRIDOR_PORT))).toMatch(/^connected:/);
        expect(await probe(tcpProbe(addresses.inner, GATEKEEPER_CORRIDOR_PORT))).toMatch(/^connected:/);

        for (const address of [GATEKEEPER_ALIAS, addresses.inner, addresses.outer, '127.0.0.1'].filter(Boolean)) {
          expect(await probe(tcpProbe(address, GATEKEEPER_CONTROL_PORT)), address).toMatch(/^failed:/);
        }
        for (const target of [`127.0.0.1:${GATEKEEPER_CONTROL_PORT}`, `${addresses.inner}:${GATEKEEPER_CONTROL_PORT}`, `[::1]:${GATEKEEPER_CONTROL_PORT}`]) {
          expect(await probe(corridorProbe(target)), target).toMatch(/^answer:HTTP\/1\.1 403 /);
        }
        expect(await probe(windowProbe('/network'))).toMatch(/^403 /);
        expect(await probe(windowProbe('/model/../network'))).toMatch(/^403 /);
      }, 180_000);

      it('finds the gatekeeper at the .1 address of its own subnet, which is no proof of a host', async () => {
        const { inner } = await host.gatekeeperAddresses(spec.id);
        const answer = await probe(tcpProbe(inner, GATEKEEPER_CORRIDOR_PORT));
        expect(answer).toMatch(/^connected:/);
        expect(inner.endsWith('.1'), `the gatekeeper is at ${inner}`).toBe(true);
      });

      describe('the model key', () => {
        let upstream: WindowUpstream = { url: '', seen: async () => [], stop: async () => {} };

        beforeAll(async () => {
          upstream = await host.startWindowUpstream(spec.id);
          await channel().addGrant(spec.id, { id: 'anthropic', upstream: upstream.url, header: 'x-api-key', secret: MODEL_KEY });
          await channel().addGrant(spec.id, { id: 'openai', upstream: upstream.url, header: 'authorization', secret: MODEL_KEY });
        }, 120_000);

        afterAll(async () => {
          await upstream.stop();
        });

        it('positive control: the key is real and the window carries it to the upstream', async () => {
          const answer = await probe(windowProbe('/model/anthropic/messages?stream=true', { 'x-api-key': 'sk-fake-inside', authorization: 'Bearer sk-fake-inside' }));
          expect(answer).toMatch(/^200 /);
          const seen = parseWindowSeen(answer);
          expect(seen.apiKey).toBe(sha256(MODEL_KEY));
          expect(seen.authorization).toBe('none');
          expect(seen.path).toBe('/v1/messages?stream=true');

          const bearer = parseWindowSeen(await probe(windowProbe('/model/openai/responses')));
          expect(bearer.authorization).toBe(sha256(`Bearer ${MODEL_KEY}`));
          expect(bearer.apiKey).toBe('none');
        }, 120_000);

        it('is nowhere the space can look', async () => {
          const answer = await probe(windowProbe('/model/anthropic/messages'));
          expect(answer).not.toContain(MODEL_KEY);
          expect(await probe(windowProbe('/model/nothing/here'))).not.toContain(MODEL_KEY);

          const insideTheSpace = await shell(`env; ps auxeww; find /home/space /tmp /spaces/${spec.id} -type f -size -1M -exec cat {} + 2>/dev/null; true`);
          expect(insideTheSpace.stdout.length).toBeGreaterThan(0);
          expect(insideTheSpace.stdout).not.toContain(MODEL_KEY);

          expect(await host.spaceMetadata(spec.id)).not.toContain(MODEL_KEY);
          const gatekeeperMetadata = await host.gatekeeperMetadata(spec.id);
          expect(gatekeeperMetadata).toContain('HOME=/tmp');
          expect(gatekeeperMetadata).not.toContain(MODEL_KEY);

          const journal = await channel().readJournal(spec.id);
          expect(JSON.stringify(journal)).not.toContain(MODEL_KEY);
        }, 120_000);

        it('cannot be reached on its outer address: the corridor and the window listen on the inner network only', async () => {
          const addresses = await host.gatekeeperAddresses(spec.id);
          expect(addresses.outer).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
          const fromOutside = async (address: string, port: number) => (await host.probeFromOuterNetwork(spec.id, tcpProbe(address, port))).stdout.trim();
          expect(await fromOutside('upstream', 9000)).toMatch(/^connected:/);
          for (const port of [GATEKEEPER_CORRIDOR_PORT, GATEKEEPER_WINDOW_PORT, GATEKEEPER_CONTROL_PORT]) {
            expect(await fromOutside(addresses.outer, port), `outer address, port ${port}`).toBe('failed:ECONNREFUSED');
          }
          expect(await probe(tcpProbe(GATEKEEPER_ALIAS, GATEKEEPER_CORRIDOR_PORT))).toBe(`connected:${addresses.inner}`);
          expect(await probe(tcpProbe(GATEKEEPER_ALIAS, GATEKEEPER_WINDOW_PORT))).toBe(`connected:${addresses.inner}`);
        }, 180_000);

        it('gets no credential from the window for an opened domain, and none of its own reaches the upstream', async () => {
          await channel().addGrant(spec.id, { id: 'open-registry', upstream: upstream.url });
          const answer = await probe(windowProbe('/model/open-registry/-/package/left-pad', { 'x-api-key': 'sk-fake-inside', authorization: 'Bearer sk-fake-inside' }));
          expect(answer).toMatch(/^200 /);
          const seen = parseWindowSeen(answer);
          expect(seen.path).toBe('/v1/-/package/left-pad');
          expect(seen.apiKey).toBe('none');
          expect(seen.authorization).toBe('none');
          expect(seen.headerNames.filter((name) => /key|auth|token/i.test(name))).toEqual([]);
          expect(answer).not.toContain(MODEL_KEY);
        }, 120_000);

        it('reaches a real upstream over TLS, with no credential of anyone\'s', async () => {
          publicAddress();
          await channel().addGrant(spec.id, { id: 'tls', upstream: 'https://example.com/', header: 'authorization', secret: 'not-a-credential' });
          const answer = await probe(windowProbe('/model/tls/'));
          if (answer.startsWith('502 ')) {
            throw new Error(`Inconclusive: the window allowed the upstream and the Docker machine could not reach it (${answer}).`);
          }
          expect(answer).toMatch(/^200 /);
          expect(answer).toContain('Example Domain');
        }, 120_000);

        it('keeps paths, queries, bodies and header values out of the journal', async () => {
          await probe(windowProbe('/model/anthropic/messages?secret-query=leak-me', { authorization: 'Bearer leak-me-too' }));
          await probe(corridorProbe('leak-me.example.com:443'));

          const journal = await channel().readJournal(spec.id);
          expect(journal.records.length).toBeGreaterThan(0);
          for (const record of journal.records) {
            expect(Object.keys(record).sort()).toEqual(['at', 'decision', 'host', 'listener', 'port']);
          }
          const text = JSON.stringify(journal);
          expect(text).not.toContain('leak-me-too');
          expect(text).not.toContain('secret-query');
          expect(text).not.toContain('/v1/messages');
          expect(text).toContain('leak-me.example.com');
        }, 120_000);
      });

      it('cannot crash or wedge the gatekeeper with a client that means harm', async () => {
        publicAddress();
        await allow(['example.com']);
        expect(await probe(ABUSE)).toMatch(/^done:/);

        await mustCarry('example.com:443');
        const health = await createSpaceServerChannel({ exec: place.exec }).request(spec.id, { path: '/health' });
        expect(JSON.parse(health.body)).toMatchObject({ isOpenCodeReady: true });
        expect((await place.list()).find((space) => space.id === spec.id)).toMatchObject({ state: 'running', damaged: false });
      }, 240_000);

      it('cannot drown the gatekeeper in sockets, and never takes the journal with it', async () => {
        publicAddress();
        await allow(['example.com']);
        const before = (await channel().readJournal(spec.id)).records.length;

        expect(await probe(FLOOD)).toMatch(/^done:/);

        const journal = await channel().readJournal(spec.id);
        expect(journal.records.length).toBeGreaterThanOrEqual(Math.min(before, 1));
        expect(journal.records.filter((entry) => entry.decision === 'deny:too-many-connections').length).toBeLessThan(5);
        await mustCarry('example.com:443');
        expect((await place.verify(spec.id))).toEqual([]);
        expect((await place.list()).find((space) => space.id === spec.id)).toMatchObject({ state: 'running', damaged: false });
      }, 300_000);

      it('cannot hold more tunnels open than the corridor allows, and gets them back when it lets go', async () => {
        publicAddress();
        await allow(['example.com']);

        const answer = await probe(HOLD_TUNNELS);
        const counts = parseTunnelCounts(answer);
        if (counts.established === 0) {
          throw new Error(`Inconclusive: no tunnel to the allowed host was established (${JSON.stringify(counts)}), so this says nothing about the cap. Check the Docker machine's connection.`);
        }
        expect(counts.established).toBeLessThanOrEqual(64);
        expect(counts.refused).toBeGreaterThan(0);
        expect((await channel().readJournal(spec.id)).records.some((entry) => entry.decision === 'deny:too-many-tunnels')).toBe(true);

        await mustCarry('example.com:443');
      }, 300_000);

      it('holds no long-lived credential of the user\'s, anywhere the space can read', async () => {
        const search = () => shell(credentialSearch(spec.id));
        const server = createSpaceServerChannel({ exec: place.exec });
        const login = await server.request(spec.id, { method: 'POST', path: '/auth/session', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: await server.readToken(spec.id) }) });
        expect(login.status).toBe(200);
        const cookie = sessionCookieOf(login.headers);
        const pluginsLoaded = async () => {
          const answer = await server.request(spec.id, { path: '/api/plugin', headers: { Cookie: cookie } });
          expect(answer.status).toBe(200);
          return parsePluginList(answer.body).length > 0;
        };
        await server.request(spec.id, { path: '/api/integration', headers: { Cookie: cookie } });
        await expect.poll(pluginsLoaded, { timeout: 60_000, interval: 250, message: 'OpenCode loaded no plugins, so its integration list is empty and proves nothing' }).toBe(true);
        const connections = async () => {
          const answer = await server.request(spec.id, { path: '/api/integration', headers: { Cookie: cookie } });
          expect(answer.status).toBe(200);
          const integrations = parseIntegrationConnections(answer.body);
          expect(integrations.length).toBeGreaterThan(0);
          return integrations.flatMap((integration) => integration.connections.map((connection) => ({ integration: integration.id, ...connection })));
        };
        const database = `${SPACE_HOME}/.local/share/opencode/opencode.db`;
        const storedCredentials = async () => {
          const answer = await inside(['node', '--no-warnings', '-e', readCredentials(database)]);
          expect(answer.code, answer.stderr).toBe(0);
          return JSON.parse(answer.stdout);
        };
        const decoyRecord = `${SPACE_HOME}/.local/share/opencode/auth.json`;
        const decoy = 'sk-decoy00000000000000000000';

        const found = (await search()).stdout;
        expect(found).toContain('--- files');
        expect(found).toContain('--- environments');
        expect(found).toContain('--- end');
        expect(found).toContain('auth-record: absent');
        expect(found.slice(found.indexOf('--- files'))).toBe('--- files\n--- environments\n--- end\n');
        expect(await connections()).toEqual([]);
        expect(await storedCredentials()).toEqual([]);

        const planted = await shell([
          `mkdir -p "$(dirname ${decoyRecord})"`,
          `printf '{}' > ${decoyRecord}`,
          `printf -- '-----BEGIN OPENSSH PRIVATE KEY-----' > "$HOME/decoy-key"`,
          `DECOY_TOKEN=${decoy} sleep 30 & echo "decoy-pid:$!"`,
        ].join('; '));
        const decoyPid = /decoy-pid:(\d+)/.exec(planted.stdout)?.[1];
        let removal: CommandResult | undefined;
        try {
          const row = await inside(['node', '--no-warnings', '-e', plantCredential(database)]);
          expect(row.code, row.stderr).toBe(0);
          expect(await connections()).toEqual([{ integration: 'openai', type: 'credential', id: DECOY_CREDENTIAL_ID, label: 'default', method: 'oauth' }]);
          expect(await storedCredentials()).toEqual([{ integration: 'openai', type: 'oauth' }, { integration: 'acme-llm', type: 'key' }]);

          const control = (await search()).stdout;
          expect(control).toContain('auth-record: present');
          expect(control).toMatch(/opencode\.db(-wal)?:"refresh"\s*:\s*"/);
          expect(control).toContain('BEGIN OPENSSH PRIVATE KEY');
          expect(control).toContain(decoy);
        } finally {
          removal = await inside(['node', '--no-warnings', '-e', removeCredential(database)]);
          await shell(`rm -f ${decoyRecord} "$HOME/decoy-key"; ${decoyPid ? `kill ${decoyPid} 2>/dev/null` : 'true'}; true`);
        }
        expect(removal.code, removal.stderr).toBe(0);
        expect(removal.stdout).toBe('removed:2\n');
        expect(await connections()).toEqual([]);
        expect(await storedCredentials()).toEqual([]);
      }, 180_000);

      describe('another space of the same owner', () => {
        const other = {
          id: createSpaceId(),
          name: 'Escape tests, the other space',
          project: hashProjectDirectory('/escape/suite/other'),
          created: new Date().toISOString(),
          memoryBytes: MEMORY_BYTES,
        };
        let addresses = { space: '', gatekeeper: { inner: '', outer: '' } };

        beforeAll(async () => {
          await place.create(other);
          addresses = {
            space: await host.spaceAddress(other.id),
            gatekeeper: await host.gatekeeperAddresses(other.id),
          };
        }, CREATE_TIMEOUT_MS);

        afterAll(async () => {
          await place.remove(other.id);
        });

        it('positive control: the other space is up, and each space reaches its own gatekeeper', async () => {
          expect(addresses.space).toMatch(/\d+\.\d+\.\d+\.\d+/);
          expect(addresses.gatekeeper.inner).toMatch(/\d+\.\d+\.\d+\.\d+/);
          expect(addresses.gatekeeper.outer).toMatch(/\d+\.\d+\.\d+\.\d+/);

          const health = await createSpaceServerChannel({ exec: place.exec }).request(other.id, { path: '/health' });
          expect(JSON.parse(health.body)).toMatchObject({ isOpenCodeReady: true });

          const fromOther = await place.exec(other.id, ['node', '-e', tcpProbe(addresses.gatekeeper.inner, GATEKEEPER_CORRIDOR_PORT)], { timeoutMs: 60_000 });
          expect(fromOther.stdout.trim()).toMatch(/^connected:/);
          expect(await probe(tcpProbe(GATEKEEPER_ALIAS, GATEKEEPER_CORRIDOR_PORT))).toMatch(/^connected:/);
        }, 120_000);

        it('cannot reach the other space, its gatekeeper, or anything they listen on', async () => {
          const targets: [string, number][] = [
            [addresses.space, SPACE_SERVER_PORT],
            [addresses.gatekeeper.inner, GATEKEEPER_CORRIDOR_PORT],
            [addresses.gatekeeper.inner, GATEKEEPER_WINDOW_PORT],
            [addresses.gatekeeper.inner, GATEKEEPER_CONTROL_PORT],
            [addresses.gatekeeper.outer, GATEKEEPER_CORRIDOR_PORT],
            [addresses.gatekeeper.outer, GATEKEEPER_WINDOW_PORT],
            [addresses.gatekeeper.outer, GATEKEEPER_CONTROL_PORT],
          ];
          for (const [address, port] of targets) {
            expect(await probe(tcpProbe(address, port)), `${address}:${port}`).toMatch(/^failed:/);
          }
        }, 180_000);

        it('cannot ask its own corridor for the other space either, in either mode', async () => {
          for (const change of [() => allow(['example.com']), open]) {
            await change();
            for (const address of [addresses.space, addresses.gatekeeper.inner, addresses.gatekeeper.outer]) {
              expect(await probe(corridorProbe(`${address}:443`)), address).toMatch(/^answer:HTTP\/1\.1 403 /);
            }
          }
        }, 180_000);

        it('finds its own gatekeeper under the shared name, never the other space\'s', async () => {
          const mine = await host.gatekeeperAddresses(spec.id);
          const resolved = await probe(`${PROBE_HEAD}
require('node:dns').promises.lookup('${GATEKEEPER_ALIAS}').then((answer) => done('resolved:' + answer.address), (error) => done('failed:' + error.code));
`);
          expect(resolved).toBe(`resolved:${mine.inner}`);
          expect(resolved).not.toContain(addresses.gatekeeper.inner);
          expect(resolved).not.toContain(addresses.gatekeeper.outer);
        }, 120_000);
      });

      it('is itself hardened, seen from inside it', async () => {
        expect((await inGatekeeper(['id', '-u'])).stdout).toBe('1000\n');
        const status = (await inGatekeeper(['cat', '/proc/self/status'])).stdout;
        expect(status).toMatch(/^NoNewPrivs:\s+1$/m);
        expect(status).toMatch(/^CapEff:\s+0000000000000000$/m);
        expect(status).toMatch(/^Seccomp:\s+2$/m);

        const write = await inGatekeeper(['sh', '-c', 'touch /etc/openchamber-escape-probe']);
        expect(write.code).not.toBe(0);
        expect(write.stderr).toMatch(/Read-only file system/);
        expect((await inGatekeeper(['sh', '-c', 'echo kept > /tmp/probe && cat /tmp/probe'])).stdout).toBe('kept\n');
        expect((await inGatekeeper(['test', '-e', '/var/run/docker.sock'])).code).not.toBe(0);
        expect((await inGatekeeper(['sh', '-c', 'ls /opt/openchamber-tools 2>&1; true'])).stdout).toMatch(/No such file/);
      }, 120_000);
    });

    it('gets a process killed when it takes more memory than the limit, and nothing else', async () => {
      const result = await inside(['node', '-e', ALLOCATE_WITHOUT_END]);
      expect(result.code).toBe(137);

      expect(await inside(['echo', 'alive'])).toMatchObject({ code: 0, stdout: 'alive\n' });
      expect((await place.list()).find((space) => space.id === spec.id)).toMatchObject({ state: 'running' });
      const health = await createSpaceServerChannel({ exec: place.exec }).request(spec.id, { path: '/health' });
      expect(JSON.parse(health.body)).toMatchObject({ isOpenCodeReady: true });
      expect(await place.check()).toMatchObject({ available: true });
    }, 120_000);
  });
}
