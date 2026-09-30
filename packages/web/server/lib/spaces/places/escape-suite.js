// Escape tests. Each one runs inside a real space as the attacker and passes only
// when the attempt fails. Every place runs this same suite.
//
// `setup` resolves `{ place, dispose, host }`. `host` is the test's own view from outside the space:
//   runUnrestricted(script)  runs a node script in a plain container with normal networking
//   startHostListener()      resolves { port, candidates, stop } for a TCP listener on the place's host,
//                            and `candidates`: every IPv4 address of that host plus the names that may lead to it
//   createPlainInternalNetwork()  resolves { run(script), remove } for an internal network WITHOUT the space's isolation
//   logBytes(spaceId)        resolves how many bytes of space output the host keeps
//   spaceMetadata(spaceId)   resolves, as text, everything the place's own records show about the space container
//   gatekeeperMetadata(spaceId)   the same for the gatekeeper container
//   gatekeeperAddresses(spaceId)  resolves { inner, outer }, the gatekeeper's own addresses
//   probeFromOuterNetwork(spaceId, script)  runs a Node script in a helper on the space's outer network
//   startWindowUpstream(spaceId)  a stand-in provider on the space's outer network. It answers with
//                                 the sha256 of the credentials it saw, never with the credentials

import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

const CREATE_TIMEOUT_MS = 25 * 60_000;
// The server and OpenCode inside take about 370 MiB at rest. With 1 GiB the process that
// allocates without end is by far the largest when the limit is hit, so it is the one that gets killed.
const MEMORY_BYTES = 1024 * 1024 * 1024;
const LOG_CAP_BYTES = 11 * 1024 * 1024;

// Every probe prints one line, `connected:<ip>` or `failed:<reason>`, and exits 0 within ten seconds.
const PROBE_HEAD = "const done = (text) => { console.log(text); process.exit(0); };";

const tcpProbe = (host, port) => `${PROBE_HEAD}
const socket = require('node:net').connect({ host: '${host}', port: ${port} });
socket.setTimeout(4000, () => done('failed:timeout'));
socket.on('connect', () => done('connected:' + socket.remoteAddress));
socket.on('error', (error) => done('failed:' + error.code));
`;

// Tries every candidate at once and prints one JSON object: candidate to `connected:<ip>` or `failed:<reason>`.
const hostProbe = (candidates, port) => `
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

// Resolves a public name and connects to it. Prints `connected:<ip>` so the space can try the same address.
const INTERNET_BASELINE = `${PROBE_HEAD}
setTimeout(() => done('failed:timeout'), 9000);
require('node:dns').promises.lookup('example.com', { family: 4 }).then(({ address }) => {
  const socket = require('node:net').connect({ host: address, port: 443 });
  socket.on('connect', () => done('connected:' + address));
  socket.on('error', (error) => done('failed:' + error.code));
}, (error) => done('failed:' + error.code));
`;

// Prints one line per listening TCP socket, IPv4 and IPv6: `<local address in hex>:<port in hex>`.
const LISTENERS = "cat /proc/net/tcp /proc/net/tcp6 | awk '$4 == \"0A\" { print $2 }'";
// 127.0.0.0/8 in the kernel's byte order, or ::1. Docker's own DNS stub listens on 127.0.0.11.
const LOOPBACK_LISTENER = /^([0-9A-F]{6}7F|00000000000000000000000001000000):[0-9A-F]{4}$/;

const ALLOCATE_WITHOUT_END = 'const kept = []; for (;;) kept.push(Buffer.alloc(16 * 1024 * 1024, 1));';

// One CONNECT to the corridor, as any client in the space sends it. Prints the status line.
const corridorProbe = (target) => `${PROBE_HEAD}
const socket = require('node:net').connect({ host: '${GATEKEEPER_ALIAS}', port: ${GATEKEEPER_CORRIDOR_PORT} });
let answer = '';
socket.setTimeout(20000, () => done('failed:timeout'));
socket.on('connect', () => socket.write('CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n\\r\\n'));
socket.on('data', (chunk) => { answer += chunk; if (answer.includes('\\r\\n')) done('answer:' + answer.split('\\r\\n')[0]); });
socket.on('error', (error) => done('failed:' + error.code));
`;

// One request through the window. Prints the status and the body, both of them data from outside.
const windowProbe = (path, headers = {}) => `${PROBE_HEAD}
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

// What a client that means harm sends. None of it may end the gatekeeper or block another client.
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

// Sockets without end, which is what it takes to have the gatekeeper killed for its memory.
// They connect and then say nothing, so each one sits in the corridor's header window.
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

// As many tunnels at once as the space can get, to a name the host allowed. Prints how many were
// established and how many the corridor refused, then lets every one of them go.
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
Promise.all(Array.from({ length: 80 }, attempt)).then((outcomes) => {
  const counts = { established: 0, refused: 0, unreachable: 0, failed: 0 };
  for (const outcome of outcomes) counts[outcome] += 1;
  for (const socket of kept) socket.destroy();
  setTimeout(() => done('done:' + JSON.stringify(counts)), 1000);
});
`;

// What a long-lived credential looks like: an OpenAI-style oauth record with a refresh token,
// a private key, a GitHub token, a provider key. A log line that happens to say "refresh" does
// not match, which is why each pattern carries its punctuation.
const LONG_LIVED_CREDENTIAL = '"refresh"[[:space:]]*:[[:space:]]*"|BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{16}|sk-[A-Za-z0-9_-]{20}|xox[baprs]-';

/** Everything the space holds that could be a long-lived credential, as text for the host to read.
 * HOME, the work directory and /tmp, which is writable and 256 MiB. `-a` reads binary files as
 * text: OpenCode 2 keeps its logins in the SQLite database `opencode.db` under HOME, and `-I`
 * skipped that file. `-o` prints the matched shape and its file, never the binary around it. */
const credentialSearch = (spaceId) => `
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin;
echo "auth-record: $([ -e "$HOME/.local/share/opencode/auth.json" ] && echo present || echo absent)";
echo "--- files";
grep -raosE '${LONG_LIVED_CREDENTIAL}' "$HOME" /tmp /spaces/${spaceId} 2>/dev/null | head -20;
echo "--- environments";
for process in /proc/[0-9]*/environ; do tr '\\0' '\\n' < "$process" 2>/dev/null; done | grep -E '${LONG_LIVED_CREDENTIAL}' | head -20;
echo "--- end";
`;

// OpenCode 2's own login store: rows in the `credential` table of `opencode.db`. The control
// writes two the way OpenCode stores them: an OpenAI browser login, and a key for a provider of the
// user's own that OpenCode's catalog does not know, which no integration route lists and no key
// pattern matches. No route can create an OAuth record without a real login, so the rows are
// written with Node's built-in SQLite into the database the running OpenCode uses. The timeout
// waits for OpenCode's own lock instead of failing on it.
const DECOY_CREDENTIAL_ID = 'cred_decoy000000000000000000';
const DECOY_CUSTOM_CREDENTIAL_ID = 'cred_decoy000000000000000001';
const openDatabase = (databasePath, options = '{ timeout: 5000 }') => `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(${JSON.stringify(databasePath)}, ${options});
`;
const plantCredential = (databasePath) => `${openDatabase(databasePath)}
const now = Date.now();
const insert = db.prepare('INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)');
insert.run('${DECOY_CREDENTIAL_ID}', 'openai', 'default', JSON.stringify({ type: 'oauth', methodID: 'chatgpt-browser', refresh: 'decoy-refresh-value', access: 'decoy-access-value', expires: now + 3600000 }), 1, now, now);
insert.run('${DECOY_CUSTOM_CREDENTIAL_ID}', 'acme-llm', 'default', JSON.stringify({ type: 'key', key: 'acme_live_decoy' }), 1, now, now);
db.close();
`;
const removeCredential = (databasePath) => `${openDatabase(databasePath)}
const { changes } = db.prepare('DELETE FROM credential WHERE id IN (?, ?)').run('${DECOY_CREDENTIAL_ID}', '${DECOY_CUSTOM_CREDENTIAL_ID}');
db.close();
console.log('removed:' + changes);
`;
// Every stored login, by integration and kind, read straight from the table. OpenCode lists only
// the integrations its catalog knows, so this is the check that sees a custom provider's key.
const readCredentials = (databasePath) => `${openDatabase(databasePath, '{ readOnly: true, timeout: 5000 }')}
const rows = db.prepare("SELECT integration_id AS integration, json_extract(value, '$.type') AS type FROM credential ORDER BY id").all();
db.close();
console.log(JSON.stringify(rows.map((row) => ({ integration: row.integration, type: row.type }))));
`;

const sleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

const sha256 = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

export function runEscapeSuite(title, { enabled = true, setup }) {
  describe.skipIf(!enabled)(`escape tests: ${title}`, () => {
    const spec = {
      id: createSpaceId(),
      name: 'Escape tests',
      project: hashProjectDirectory('/escape/suite/project'),
      created: new Date().toISOString(),
      memoryBytes: MEMORY_BYTES,
    };
    let place;
    let host;
    let dispose = async () => {};
    let internetBaseline = 'not run';

    const inside = (argv) => place.exec(spec.id, argv, { timeoutMs: 60_000 });
    const shell = (script) => inside(['sh', '-c', script]);

    // Without this, "cannot reach the internet" also passes on a machine that is offline.
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
      // Positive control: the tool exists, so a failure is a refusal.
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
      // Positive control: the file is there and readable.
      expect((await inside(['cat', '/proc/sys/kernel/hostname'])).code).toBe(0);
      const result = await shell('echo escaped > /proc/sys/kernel/hostname');
      expect(result.code).not.toBe(0);
      expect((await inside(['cat', '/proc/sys/kernel/hostname'])).stdout).not.toContain('escaped');
    });

    it.each(['/', '/etc', '/usr'])('cannot write to %s', async (directory) => {
      const result = await shell(`touch ${directory}/openchamber-escape-probe`);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/Read-only file system|Permission denied/);
    });

    it.each(['/var/run/docker.sock', '/run/docker.sock'])('has no runtime socket at %s', async (socketPath) => {
      expect((await inside(['test', '-e', socketPath])).code).not.toBe(0);
      // Positive control for `test -e` itself.
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
      // The plain network comes first, so its gateway is among the addresses the listener reports.
      const plain = await host.createPlainInternalNetwork();
      let listener = { stop: async () => {} };
      try {
        listener = await host.startHostListener();
        const { port, candidates } = listener;
        const connected = (answers) => Object.entries(answers).filter(([, answer]) => answer.startsWith('connected:'));
        const probe = async (run) => JSON.parse((await run(hostProbe(candidates, port))).stdout);

        // Control 1: the listener is up. A container with normal networking reaches it.
        let fromOutside = {};
        for (let attempt = 0; attempt < 20 && connected(fromOutside).length === 0; attempt += 1) {
          await sleep(250);
          fromOutside = await probe(host.runUnrestricted);
        }
        if (connected(fromOutside).length === 0) {
          throw new Error(`Inconclusive: a container with normal networking reached the host listener through none of ${candidates.join(', ')}.`);
        }

        // Control 2: the hole is real here and this probe sees it. A container on an internal
        // network WITHOUT the space's isolation reaches the host through that network's gateway.
        const fromPlain = await probe(plain.run);
        if (connected(fromPlain).length === 0) {
          throw new Error(`Inconclusive: from a plain internal network no host address connected (${JSON.stringify(fromPlain)}), so this probe cannot show the hole and a failure inside the space proves nothing.`);
        }

        // The space itself tries every candidate and every address a control reached through a name.
        // All must fail. A name that does not resolve counts as failed.
        const reached = [...connected(fromOutside), ...connected(fromPlain)].map(([, answer]) => answer.replace(/^connected:/, ''));
        const targets = [...new Set([...candidates, ...reached.filter((address) => net.isIP(address) !== 0)])];
        // Since stage 2 the `.1` address of the space's own subnet belongs to the gatekeeper, because
        // it is the first container on that network. A connection to it is not an escape, and this
        // test must never take it for one.
        const { inner } = await host.gatekeeperAddresses(spec.id);
        expect(targets, `the gatekeeper's own address ${inner} is not a host address`).not.toContain(inner);
        const result = await inside(['node', '-e', hostProbe(targets, port)]);
        expect(result.code).toBe(0);
        const fromSpace = JSON.parse(result.stdout);
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
      // Positive control: the listing is real and shows the space volume.
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

        // The server that runs right now was started from the mount, and so was its OpenCode.
        const running = (await shell("for pid in /proc/[0-9]*; do tr '\\0' ' ' < $pid/cmdline; echo; done")).stdout;
        expect(running).toMatch(new RegExp(`node ${launcher} serve --foreground`));
        expect(running).toMatch(new RegExp(`${TOOLS_MOUNT_PATH}/node_modules/\\S*opencode\\S* serve`));
      });

      it('is mounted read-only', async () => {
        const mounts = (await inside(['cat', '/proc/mounts'])).stdout.split('\n').filter((line) => line.split(' ')[1] === TOOLS_MOUNT_PATH);
        expect(mounts).toHaveLength(1);
        expect(mounts[0].split(' ')[3].split(',')).toContain('ro');
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
      ])('cannot %s', async (title, script) => {
        const before = await fingerprint();
        // Positive control: the fingerprint is real, so "unchanged" below means something.
        expect(before).toMatch(/^[0-9a-f]{64}  /);

        const result = await shell(script);
        expect(result.code).not.toBe(0);
        // Root owns these files, so "Permission denied" would also stop this user on a WRITABLE mount
        // and would prove nothing about the mount. Only the kernel's answer for a read-only mount counts.
        expect(result.stderr).toMatch(/Read-only file system/);
        expect(result.stderr).not.toMatch(/Permission denied|Operation not permitted/);
        expect(await fingerprint()).toBe(before);
      });

      // The one attempt that the read-only mount does not get to answer. To open an existing file
      // without truncating it, the kernel checks the file's permissions first, and root owns the file.
      // So this proves the ownership, not the mount. The attempts above prove the mount.
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
      // Positive control: this is the real token. The server inside accepts it and refuses another one.
      expect(token.length).toBeGreaterThanOrEqual(32);
      const login = (password) => server.request(spec.id, { method: 'POST', path: '/auth/session', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      expect((await login(token)).status).toBe(200);
      expect((await login(`${token}x`)).status).toBe(401);

      const metadata = await host.spaceMetadata(spec.id);
      // Positive control: the metadata is real and complete enough to show the environment.
      expect(metadata).toContain('OPENCODE_DISABLE_AUTOUPDATE=1');
      expect(metadata).not.toContain(token);
    });

    it('cannot steer the requests of the host through its own ~/.curlrc', async () => {
      const server = createSpaceServerChannel({ exec: place.exec });
      try {
        await shell(`printf 'write-out = "INJECTED-BY-THE-AGENT"\\n' > "$HOME/.curlrc"`);
        // Positive control: this curl does read the file, so an unprotected request would carry the text.
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
      // Positive control: the server inside is among them, so the listing is real.
      expect(listeners).toContain(`0100007F:${SPACE_SERVER_PORT.toString(16).toUpperCase().padStart(4, '0')}`);
      expect(listeners.filter((listener) => !LOOPBACK_LISTENER.test(listener))).toEqual([]);
    });

    it('cannot fill the disk of the host through its own output', async () => {
      // 50 MB to the stdout of PID 1, which is what the place keeps as the container log.
      const flood = await shell('head -c 52428800 /dev/zero | tr "\\0" x | fold -w 1000 > /proc/1/fd/1');
      // Positive control: the write went through, and the host kept some of it.
      expect(flood.code).toBe(0);
      const kept = await host.logBytes(spec.id);
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(LOG_CAP_BYTES);
    }, 120_000);

    describe('gatekeeper', () => {
      // The key the gatekeeper holds for the space. It is made here and never enters the space.
      const MODEL_KEY = `sk-live-${crypto.randomBytes(24).toString('hex')}`;
      const channel = () => createGatekeeperChannel({ exec: place.exec });
      const probe = async (script) => {
        const result = await inside(['node', '-e', script]);
        expect(result.code, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      const inGatekeeper = (argv) => place.exec(spec.id, argv, { timeoutMs: 60_000, target: 'gatekeeper' });

      /**
       * A CONNECT that must go through. A 502 means the corridor allowed the target and the
       * connection out did not happen: the Docker machine's link, not the restriction under test.
       * That ends the test as inconclusive, with the host and the answer named, the same way the
       * internet baseline does. The refusals stay hard assertions, because they are the point.
       */
      const mustCarry = async (target) => {
        const answer = await probe(corridorProbe(target));
        if (/^answer:HTTP\/1\.1 502 /.test(answer)) {
          throw new Error(`Inconclusive: the corridor allowed ${target} and the Docker machine could not reach it (${answer}). While that is true, what is refused below says nothing about the restriction.`);
        }
        expect(answer, target).toMatch(/^answer:HTTP\/1\.1 200 /);
        return answer;
      };
      const allow = (domains) => channel().setNetwork(spec.id, { mode: 'allowlist', domains });
      const open = () => channel().setNetwork(spec.id, { mode: 'open', domains: [] });
      /**
       * Where the journal stands now, counted in records ever written: the ring plus what has
       * fallen out of it. A mark, never a time. The record's stamp comes from a clock inside a
       * container and the test reads one on the host, and nothing makes those two agree to the
       * millisecond; on Windows they were measured disagreeing by a timer tick, which is enough
       * to hide a refusal decided the instant it was asked for.
       */
      const journalMark = async () => {
        const { records, dropped } = await channel().readJournal(spec.id);
        return records.length + dropped;
      };

      /**
       * The last decision about this destination among the records written since `mark`. Without
       * the mark a test reads a record an earlier test left behind and passes on it.
       */
      const decisionFor = async (host, mark = 0) => {
        const { records, dropped } = await channel().readJournal(spec.id);
        const since = Math.max(0, records.length + dropped - mark);
        const fresh = records.slice(Math.max(0, records.length - since)).filter((entry) => entry.host === host);
        expect(fresh.length, `the gatekeeper decided nothing about ${host}`).toBeGreaterThan(0);
        return fresh.at(-1);
      };

      // The two names this control carries to are both IANA's reserved documentation domains, so
      // the whole live suite leans on one operator rather than two. It used to allow a product
      // service for the second half, and on one machine that host answered 502 and reported a
      // failed restriction where the restriction had worked.
      it('positive control: the corridor carries what the host allowed, and refuses everything else', async () => {
        publicAddress();
        await allow(['example.com']);

        await mustCarry('example.com:443');
        expect(await probe(corridorProbe('example.org:443'))).toMatch(/^answer:HTTP\/1\.1 403 /);
        expect((await decisionFor('example.org')).decision).toBe('deny:not-on-allowlist');
        // The allowlist changes live: no restart, and the next attempt is decided by the new list.
        await allow(['example.org']);
        await mustCarry('example.org:443');
        expect(await probe(corridorProbe('example.com:443'))).toMatch(/^answer:HTTP\/1\.1 403 /);
      }, 120_000);

      // There is no live "carries ten megabytes" test here, and that is deliberate. It pulled a
      // published tarball from the npm registry, so a bad minute at somebody else's service made a
      // run inconclusive, which is a failed run with no evidence in it. What it was for — that a
      // large transfer arrives whole — is proved better without a network: `joinSockets` in
      // `gatekeeper-program.test.js` carries four megabytes full duplex while the space is still
      // uploading and compares sha256, it is byte-exact, and it fails when the teardown goes back.
      // The live half of the claim, that the corridor carries to a real host through a real
      // container, is the positive control above. Do not add a large download back thinking this
      // path is uncovered.

      it('cannot reach auth.openai.com in allowlist mode, even with it on the list', async () => {
        await allow(['auth.openai.com', 'example.com']);
        expect(await probe(corridorProbe('auth.openai.com:443'))).toMatch(/^answer:HTTP\/1\.1 403 /);
        expect((await decisionFor('auth.openai.com')).decision).toBe('deny:always-refused');
        // In this mode that is the whole story: only the names on the list pass at all.
      }, 120_000);

      // In open mode this is a lock and not a guarantee, and the test says no more than it sees.
      // A space in open mode reaches every public host on 443, so it can go through a third-party
      // intermediary and the corridor sees only that name. What holds in both modes is that the
      // long-lived refresh token is never inside the space, which is the test below.
      it('is refused for the name and for the address of auth.openai.com in open mode, which is a lock and not a guarantee', async () => {
        await open();
        expect(await probe(corridorProbe('auth.openai.com:443'))).toMatch(/^answer:HTTP\/1\.1 403 /);
        expect((await decisionFor('auth.openai.com')).decision).toBe('deny:always-refused');
      }, 120_000);

      // A refusal that is only about a name is no refusal. The space cannot resolve a public name
      // itself, but in open mode it could ask a public DNS-over-HTTPS resolver through this same
      // corridor and then connect to the address. So every form of the address must be refused too.
      it('refuses the address of a refused name as well, in either mode', async () => {
        const answers = await dns.lookup('auth.openai.com', { all: true, family: 4 }).catch(() => []);
        if (answers.length === 0) {
          throw new Error('Inconclusive: auth.openai.com did not resolve here, so the address form cannot be tried.');
        }
        const address = answers[0].address;
        const octets = address.split('.').map(Number);
        const asInteger = ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
        const targets = [
          `${address}:443`,
          `${address}:8443`,
          `[::ffff:${address}]:443`,
          `[2002:${octets.slice(0, 2).map((part) => part.toString(16).padStart(2, '0')).join('')}:0::1]:443`,
          // The same address as one integer, and in hex, and in three parts. Each of these is an
          // address to the C library of this image, and none of them is four dotted octets. The
          // first one carried a real TLS session to this host through the corridor in an earlier draft.
          `${asInteger}:443`,
          `0x${asInteger.toString(16).padStart(8, '0')}:443`,
          `${octets[0]}.${octets[1]}.${octets[2] * 256 + octets[3]}:443`,
        ];

        for (const change of [() => allow(['auth.openai.com', 'example.com']), open]) {
          await change();
          for (const target of targets) {
            expect(await probe(corridorProbe(target)), target).toMatch(/^answer:HTTP\/1\.1 403 /);
          }
          // The corridor takes names, so this is the reason, not the allowlist and not the port.
          expect((await decisionFor(address)).decision).toBe('deny:not-a-name');
        }

        // Control: the gatekeeper itself reaches that address, so the refusal is the corridor's.
        const reached = (await inGatekeeper(['node', '-e', tcpProbe(address, 443)])).stdout.trim();
        if (!reached.startsWith('connected:')) {
          throw new Error(`Inconclusive: the gatekeeper could not reach ${address} either (${reached}).`);
        }
      }, 180_000);

      it('reaches an allowed name on 443 and on no other port, in either mode', async () => {
        publicAddress();
        // Not a speed bump: over any other port a space could attack a third party from the
        // user's address, and nothing about open mode changes that.
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

      // Two things at once. Every address target is refused before the corridor looks at where it
      // points, which is the name rule. Every name Docker injects for its host, where it resolves,
      // is refused by the address it resolves to: measured with the address block removed,
      // `host.docker.internal` answered 502 instead of 403, so that half is the block doing the work.
      it('cannot ask the corridor for the Docker host, by address or by the names Docker injects', async () => {
        const listener = await host.startHostListener();
        try {
          const { port, candidates } = listener;
          const addresses = candidates.filter((candidate) => net.isIP(candidate) !== 0);

          // Control: the gatekeeper itself can reach the host. So a refusal below is the corridor's
          // doing and not a missing route. This is the whole point of the test.
          const fromGatekeeper = JSON.parse((await inGatekeeper(['node', '-e', hostProbe(candidates, port)])).stdout);
          const reached = Object.entries(fromGatekeeper).filter(([, answer]) => answer.startsWith('connected:'));
          if (reached.length === 0) {
            throw new Error(`Inconclusive: the gatekeeper reached the host through none of ${candidates.join(', ')} (${JSON.stringify(fromGatekeeper)}), so a refusal proves nothing.`);
          }

          for (const change of [() => allow(['example.com']), open]) {
            await change();
            for (const address of addresses) {
              // On 443, where the corridor's port rule is out of the way, and on the listener's port.
              expect(await probe(corridorProbe(`${address}:443`)), address).toMatch(/^answer:HTTP\/1\.1 403 /);
              expect(await probe(corridorProbe(`${address}:${port}`)), address).toMatch(/^answer:HTTP\/1\.1 403 /);
            }
            // The IPv4-mapped IPv6 form of the same addresses is the same address.
            for (const address of addresses) {
              expect(await probe(corridorProbe(`[::ffff:${address}]:443`)), address).toMatch(/^answer:HTTP\/1\.1 403 /);
            }
            // And by a name that Docker Desktop injects for the host, where it resolves.
            for (const name of candidates.filter((candidate) => net.isIP(candidate) === 0)) {
              expect(await probe(corridorProbe(`${name}:443`)), name).toMatch(/^answer:HTTP\/1\.1 403 /);
            }
          }
        } finally {
          await listener.stop();
        }
      }, 300_000);

      // Since the corridor takes names only, an address in a CONNECT target is refused before the
      // address block is consulted. So the block is proved here the one way that still reaches it:
      // by a name that resolves into a range it refuses. That name used to come from a third-party
      // wildcard DNS service, and twice a bad minute at one of those turned a run on somebody's
      // machine into an inconclusive one, which is a failed run with no evidence in it. A test
      // that cries wolf gets ignored, so the name is ours now.
      it('cannot reach a private address through the corridor by a name that resolves to it', async () => {
        publicAddress();
        const blocked = await host.startBlockedName(spec.id);
        try {
          // Docker's own resolver answers this name, with the helper's address on the space's
          // outer bridge. Nothing outside this machine is involved in the verdict.
          expect(blocked.address, 'the helper container has no address on the outer network').toMatch(/^\d+\.\d+\.\d+\.\d+$/);
          const isPrivate = /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(blocked.address);
          if (!isPrivate) {
            throw new Error(`Inconclusive: this Docker daemon put the helper on ${blocked.address}, which is not a range the corridor refuses, so the address rule cannot be shown this way here.`);
          }
          // Allowed by name in one mode and by open mode in the other, so what refuses it is the
          // address it resolves to and nothing about the name.
          for (const change of [() => allow([blocked.alias]), open]) {
            await change();
            const at = await journalMark();
            expect(await probe(corridorProbe(`${blocked.alias}:443`))).toMatch(/^answer:HTTP\/1\.1 403 /);
            // Not inconclusive if this does not resolve: it is our name in our resolver, so a
            // name that does not answer is this suite being wrong about its own setup.
            expect((await decisionFor(blocked.alias, at)).decision).toBe('deny:blocked-address');
          }
        } finally {
          await blocked.stop();
        }
      }, 240_000);

      it('cannot reach the control channel of its own gatekeeper, on any address it has', async () => {
        const addresses = await host.gatekeeperAddresses(spec.id);
        expect(addresses.inner, 'the gatekeeper has no address on the inner network').toMatch(/\d+\.\d+\.\d+\.\d+/);

        // Positive control: the space can reach the gatekeeper. It is the corridor it reaches.
        expect(await probe(tcpProbe(GATEKEEPER_ALIAS, GATEKEEPER_CORRIDOR_PORT))).toMatch(/^connected:/);
        expect(await probe(tcpProbe(addresses.inner, GATEKEEPER_CORRIDOR_PORT))).toMatch(/^connected:/);

        for (const address of [GATEKEEPER_ALIAS, addresses.inner, addresses.outer, '127.0.0.1'].filter(Boolean)) {
          expect(await probe(tcpProbe(address, GATEKEEPER_CONTROL_PORT)), address).toMatch(/^failed:/);
        }
        // Not through the corridor either: loopback is a blocked address, and the control port is not 443.
        for (const target of [`127.0.0.1:${GATEKEEPER_CONTROL_PORT}`, `${addresses.inner}:${GATEKEEPER_CONTROL_PORT}`, `[::1]:${GATEKEEPER_CONTROL_PORT}`]) {
          expect(await probe(corridorProbe(target)), target).toMatch(/^answer:HTTP\/1\.1 403 /);
        }
        // And not through the window: it serves grants and nothing else.
        expect(await probe(windowProbe('/network'))).toMatch(/^403 /);
        expect(await probe(windowProbe('/model/../network'))).toMatch(/^403 /);
      }, 180_000);

      it('finds the gatekeeper at the .1 address of its own subnet, which is no proof of a host', async () => {
        // Measured on Docker 29.2.1: the first container on the isolated network gets `.1`, and the
        // gatekeeper is created first. An escape test must never read that address as the Docker host.
        const { inner } = await host.gatekeeperAddresses(spec.id);
        const answer = await probe(tcpProbe(inner, GATEKEEPER_CORRIDOR_PORT));
        expect(answer).toMatch(/^connected:/);
        expect(inner.endsWith('.1'), `the gatekeeper is at ${inner}`).toBe(true);
      });

      describe('the model key', () => {
        let upstream = { stop: async () => {} };

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
          const seen = JSON.parse(answer.slice(4));
          // The upstream saw the gatekeeper's key, not what the space sent.
          expect(seen.apiKey).toBe(sha256(MODEL_KEY));
          expect(seen.authorization).toBe('none');
          expect(seen.path).toBe('/v1/messages?stream=true');

          const bearer = JSON.parse((await probe(windowProbe('/model/openai/responses'))).slice(4));
          expect(bearer.authorization).toBe(sha256(`Bearer ${MODEL_KEY}`));
          expect(bearer.apiKey).toBe('none');
        }, 120_000);

        it('is nowhere the space can look', async () => {
          const answer = await probe(windowProbe('/model/anthropic/messages'));
          expect(answer).not.toContain(MODEL_KEY);
          // An unknown grant, a refused destination: no error text carries it either.
          expect(await probe(windowProbe('/model/nothing/here'))).not.toContain(MODEL_KEY);

          // The space prints what it has, and the host looks for the key in it. Nothing of the
          // key is sent inside, not even a piece of it as a pattern to search for.
          const insideTheSpace = await shell(`env; ps auxeww; find /home/space /tmp /spaces/${spec.id} -type f -size -1M -exec cat {} + 2>/dev/null; true`);
          expect(insideTheSpace.stdout.length).toBeGreaterThan(0);
          expect(insideTheSpace.stdout).not.toContain(MODEL_KEY);

          // Not in what the place records about either container.
          expect(await host.spaceMetadata(spec.id)).not.toContain(MODEL_KEY);
          const gatekeeperMetadata = await host.gatekeeperMetadata(spec.id);
          // Positive control: the metadata is real and complete enough to show the environment.
          expect(gatekeeperMetadata).toContain('HOME=/tmp');
          expect(gatekeeperMetadata).not.toContain(MODEL_KEY);

          // And not in the journal, which is the one thing about the gatekeeper the host shows a user.
          const journal = await channel().readJournal(spec.id);
          expect(JSON.stringify(journal)).not.toContain(MODEL_KEY);
        }, 120_000);

        // The obligation of STAGES.md on the first real credential behind the window: on a Linux
        // Docker host every local process can reach the outer bridge, so the corridor and the
        // window listen on the gatekeeper's inner address only. A neighbour on the outer network
        // stands in for such a process here; the same measurement from a Linux host itself is in
        // the module documentation.
        it('cannot be reached on its outer address: the corridor and the window listen on the inner network only', async () => {
          const addresses = await host.gatekeeperAddresses(spec.id);
          expect(addresses.outer).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
          const fromOutside = async (address, port) => (await host.probeFromOuterNetwork(spec.id, tcpProbe(address, port))).stdout.trim();
          // Positive control: the neighbour's networking works, it reaches the stand-in upstream beside it.
          expect(await fromOutside('upstream', 9000)).toMatch(/^connected:/);
          for (const port of [GATEKEEPER_CORRIDOR_PORT, GATEKEEPER_WINDOW_PORT, GATEKEEPER_CONTROL_PORT]) {
            expect(await fromOutside(addresses.outer, port), `outer address, port ${port}`).toBe('failed:ECONNREFUSED');
          }
          // And the space still reaches both by the gatekeeper's name, which resolves to the inner address.
          expect(await probe(tcpProbe(GATEKEEPER_ALIAS, GATEKEEPER_CORRIDOR_PORT))).toBe(`connected:${addresses.inner}`);
          expect(await probe(tcpProbe(GATEKEEPER_ALIAS, GATEKEEPER_WINDOW_PORT))).toBe(`connected:${addresses.inner}`);
        }, 180_000);

        it('gets no credential from the window for an opened domain, and none of its own reaches the upstream', async () => {
          await channel().addGrant(spec.id, { id: 'open-registry', upstream: upstream.url });
          const answer = await probe(windowProbe('/model/open-registry/-/package/left-pad', { 'x-api-key': 'sk-fake-inside', authorization: 'Bearer sk-fake-inside' }));
          expect(answer).toMatch(/^200 /);
          const seen = JSON.parse(answer.slice(4));
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
          // The host of an attempt is recorded, and that is the point of the journal.
          expect(text).toContain('leak-me.example.com');
        }, 120_000);
      });

      it('cannot crash or wedge the gatekeeper with a client that means harm', async () => {
        publicAddress();
        await allow(['example.com']);
        expect(await probe(ABUSE)).toMatch(/^done:/);

        // Afterwards the corridor still serves a legitimate request, and the space is still healthy.
        await mustCarry('example.com:443');
        const health = await createSpaceServerChannel({ exec: place.exec }).request(spec.id, { path: '/health' });
        expect(JSON.parse(health.body)).toMatchObject({ isOpenCodeReady: true });
        expect((await place.list()).find((space) => space.id === spec.id)).toMatchObject({ state: 'running', damaged: false });
      }, 240_000);

      // The gatekeeper holds every record of what the space tried in its own memory, so a space
      // that can have it killed erases that record too. It has 256 MiB and three listeners.
      it('cannot drown the gatekeeper in sockets, and never takes the journal with it', async () => {
        publicAddress();
        await allow(['example.com']);
        const before = (await channel().readJournal(spec.id)).records.length;

        expect(await probe(FLOOD)).toMatch(/^done:/);

        // It is alive, its journal survived, and the corridor serves again.
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
        const counts = JSON.parse(answer.replace(/^done:/, ''));
        if (counts.established === 0) {
          throw new Error(`Inconclusive: no tunnel to the allowed host was established (${JSON.stringify(counts)}), so this says nothing about the cap. Check the Docker machine's connection.`);
        }
        // More than the cap were opened at once, so some were refused, and the rest were tunnels.
        expect(counts.established).toBeLessThanOrEqual(64);
        expect(counts.refused).toBeGreaterThan(0);
        expect((await channel().readJournal(spec.id)).records.some((entry) => entry.decision === 'deny:too-many-tunnels')).toBe(true);

        // Once the space lets go, the corridor carries a tunnel again.
        await mustCarry('example.com:443');
      }, 300_000);

      // The one guarantee that is ours in both modes: no long-lived credential of the user's is
      // ever inside a space. Stage 2 puts none there, and this fails the day something does.
      it('holds no long-lived credential of the user\'s, anywhere the space can read', async () => {
        const search = () => shell(credentialSearch(spec.id));
        const server = createSpaceServerChannel({ exec: place.exec });
        const login = await server.request(spec.id, { method: 'POST', path: '/auth/session', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: await server.readToken(spec.id) }) });
        expect(login.status).toBe(200);
        const cookie = login.headers['set-cookie'][0].split(';')[0];
        // What OpenCode itself holds: every connection of every integration, a stored login or a
        // provider key it found in its own environment under one of its catalog's names.
        const connections = async () => {
          const answer = await server.request(spec.id, { path: '/api/integration', headers: { Cookie: cookie } });
          expect(answer.status).toBe(200);
          const integrations = JSON.parse(answer.body).data;
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

        // The clean search runs first. SQLite keeps a deleted row's bytes in its write-ahead log,
        // so after the control below the database would hold the decoy's text for good.
        const found = (await search()).stdout;
        // Positive control of its own: the search ran and looked in all three places.
        expect(found).toContain('--- files');
        expect(found).toContain('--- environments');
        expect(found).toContain('--- end');
        expect(found).toContain('auth-record: absent');
        expect(found.slice(found.indexOf('--- files'))).toBe('--- files\n--- environments\n--- end\n');
        expect(await connections()).toEqual([]);
        expect(await storedCredentials()).toEqual([]);

        // Positive control: the same search, with a credential of each shape planted where one
        // would live. The oauth refresh record goes only into OpenCode's database, so a search
        // that skips binary files fails here. The legacy auth.json, which OpenCode 2 imports once,
        // holds nothing and only shows that its path is checked.
        const planted = await shell([
          `mkdir -p "$(dirname ${decoyRecord})"`,
          `printf '{}' > ${decoyRecord}`,
          `printf -- '-----BEGIN OPENSSH PRIVATE KEY-----' > "$HOME/decoy-key"`,
          `DECOY_TOKEN=${decoy} sleep 30 & echo "decoy-pid:$!"`,
        ].join('; '));
        const decoyPid = /decoy-pid:(\d+)/.exec(planted.stdout)?.[1];
        let removal;
        try {
          const row = await inside(['node', '--no-warnings', '-e', plantCredential(database)]);
          expect(row.code, row.stderr).toBe(0);
          // OpenCode reads the row as a login, so this is where OpenCode 2 keeps them.
          expect(await connections()).toEqual([{ integration: 'openai', type: 'credential', id: DECOY_CREDENTIAL_ID, label: 'default', method: 'oauth' }]);
          // The custom provider's key is invisible to that listing, and the table read sees it.
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
        // Checked after the finally, so a failed control above is the error that gets reported.
        expect(removal.code, removal.stderr).toBe(0);
        expect(removal.stdout).toBe('removed:2\n');
        expect(await connections()).toEqual([]);
        expect(await storedCredentials()).toEqual([]);
      }, 180_000);

      // One space is not enough to say anything about two. This makes a second one and looks
      // from the first at everything the second has. The second create costs about four seconds
      // here, because both spaces share this owner's tools volume.
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

          // The other space's server answers, so that space is alive and listening.
          const health = await createSpaceServerChannel({ exec: place.exec }).request(other.id, { path: '/health' });
          expect(JSON.parse(health.body)).toMatchObject({ isOpenCodeReady: true });

          // And each space reaches the corridor of its own gatekeeper at that same port, so a
          // refusal below is the boundary between them and not a listener that is not there.
          const fromOther = await place.exec(other.id, ['node', '-e', tcpProbe(addresses.gatekeeper.inner, GATEKEEPER_CORRIDOR_PORT)], { timeoutMs: 60_000 });
          expect(fromOther.stdout.trim()).toMatch(/^connected:/);
          expect(await probe(tcpProbe(GATEKEEPER_ALIAS, GATEKEEPER_CORRIDOR_PORT))).toMatch(/^connected:/);
        }, 120_000);

        it('cannot reach the other space, its gatekeeper, or anything they listen on', async () => {
          const targets = [
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

        // Addresses again, so this is the name rule doing the work. That the other space is out
        // of reach at all is the direct probe above.
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
        // Its own tmpfs is the one writable place, and it holds the program and nothing else.
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
      // "Nothing else" includes the server inside and its OpenCode.
      const health = await createSpaceServerChannel({ exec: place.exec }).request(spec.id, { path: '/health' });
      expect(JSON.parse(health.body)).toMatchObject({ isOpenCodeReady: true });
      expect(await place.check()).toMatchObject({ available: true });
    }, 120_000);
  });
}
