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

import net from 'node:net';
import os from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSpaceId, hashProjectDirectory } from '../labels.js';
import { SPACE_SERVER_PORT, TOOLS_BIN_PATH, TOOLS_MARKER_PATH, TOOLS_MOUNT_PATH } from '../layout.js';
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

const sleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

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
      expect(metadata).not.toContain('OPENCODE_AUTH_CONTENT');
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
