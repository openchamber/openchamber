// Runs the real connection owner against a stand-in `ssh` program, so every process, folder and
// pipe here is a real one and only the network is missing.

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSshConnections } from './ssh-connections.js';

const FAKE_SSH = `#!/bin/sh
echo "$$ $*" >> "$(dirname "$0")/log"
case "$*" in *ControlMaster=yes*) ;; *) echo "path=$PATH"; exit 0;; esac
[ -f "$(dirname "$0")/refuse" ] && exit 255
exec cat
`;

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = (condition) => vi.waitFor(() => expect(condition()).toBe(true), { timeout: 8_000 });

/** The first lease starts the login and runs without it; this is the first one that shares. */
const sharedLease = async (connections, spaceId = null) => {
  let lease = { path: null };
  await vi.waitFor(async () => {
    lease = await connections.lease(spaceId);
    expect(lease.path).not.toBeNull();
  }, { timeout: 8_000 });
  return lease;
};
/** Commands that run at the same time, each on a connection of the pool. */
const sharedLeases = async (connections, count) => {
  const leases = [];
  while (leases.length < count) leases.push(await sharedLease(connections));
  return leases;
};

/** Asks often enough, over enough pauses, that a folder the check accepts would have opened a connection. */
const settled = async (clock, connections) => {
  const started = Date.now();
  await vi.waitFor(async () => {
    clock.time += 120_000;
    expect((await connections.lease(null)).path).toBeNull();
    expect(Date.now() - started).toBeGreaterThan(500);
  }, { timeout: 5_000 });
};

describe.skipIf(process.platform === 'win32')('the shared SSH connections of a place', () => {
  const made = [];
  const stand = (options = {}) => {
    const base = fs.mkdtempSync('/tmp/oc-ssh-');
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 });
    const clock = { time: 1_000_000 };
    const spawned = [];
    const spawnMaster = (file, args) => {
      const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      spawned.push(child);
      return child;
    };
    const exits = [];
    const environment = { PATH: `${bin}:/usr/bin:/bin` };
    const directory = path.join(base, 'ssh');
    const connections = createSshConnections({
      dockerHost: 'ssh://me@box:2222', directory, environment, now: () => clock.time, spawnMaster,
      onExit: (callback) => { exits.push(callback); return () => { exits.splice(exits.indexOf(callback), 1); }; },
      ...options,
    });
    const started = () => (fs.existsSync(path.join(bin, 'log')) ? fs.readFileSync(path.join(bin, 'log'), 'utf8').trim().split('\n') : [])
      .map((line) => ({ pid: Number(line.split(' ')[0]), args: line.split(' ').slice(1) }));
    const masters = () => started().filter(({ args }) => args.includes('ControlMaster=yes'));
    made.push({ connections, base });
    return { base, bin, clock, spawned, exits, environment, directory, connections, started, masters };
  };
  afterEach(() => {
    for (const { connections, base } of made.splice(0)) {
      connections.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  const shim = (lease) => path.join(lease.path.split(':')[0], 'ssh');

  it('logs in once for many commands, with the login and the host key checks left to the user\'s ssh', async () => {
    const { connections, masters } = stand();
    (await sharedLease(connections)).release();
    for (let round = 0; round < 10; round += 1) (await connections.lease(null)).release();
    await Promise.all([1, 2, 3].map(async () => (await connections.lease(null)).release()));
    expect(masters()).toHaveLength(1);
    const [{ args }] = masters();
    expect(args.slice(-7)).toEqual(['-l', 'me', '-p', '2222', '--', 'box', 'cat']);
    const socket = args[args.indexOf('-S') + 1];
    expect(args.filter((value) => value.includes('='))).toEqual([
      'ControlMaster=yes', 'ControlPersist=no', 'BatchMode=yes', 'ClearAllForwardings=yes', 'ConnectTimeout=10', 'ServerAliveInterval=15', 'ServerAliveCountMax=3',
    ]);
    expect(args).toEqual(expect.arrayContaining(['-a', '-x']));
    for (const folder of [path.dirname(socket), path.dirname(path.dirname(socket)), path.dirname(path.dirname(path.dirname(socket)))]) {
      expect(fs.statSync(folder).mode & 0o777, folder).toBe(0o700);
    }
  });

  it('sends the docker command\'s ssh through the connection, and gives that ssh the PATH it would have had', async () => {
    const { connections, environment, started, masters, bin } = stand();
    const lease = await sharedLease(connections);
    const result = spawnSync(shim(lease), ['-T', '--', 'box', 'docker system dial-stdio'], { env: { PATH: lease.path }, encoding: 'utf8' });
    expect(result.stdout).toBe(`path=${environment.PATH}\n`);
    const socket = masters()[0].args[masters()[0].args.indexOf('-S') + 1];
    expect(started().at(-1).args).toEqual(['-S', socket, '-o', 'ControlMaster=no', '-T', '--', 'box', 'docker', 'system', 'dial-stdio']);
    expect(lease.path.endsWith(`:${bin}:/usr/bin:/bin`)).toBe(true);
  });

  it('opens another connection before one carries more than a server takes, and keeps long commands off the limit', async () => {
    const { connections, masters } = stand();
    const leases = await sharedLeases(connections, 9);
    expect(masters()).toHaveLength(3);
    const perConnection = Map.groupBy(leases, (lease) => lease.path);
    expect([...perConnection.values()].map((group) => group.length).sort()).toEqual([1, 4, 4]);
  });

  it('never shares a connection between two places, two machines or two copies of the app', async () => {
    const first = stand();
    const second = createSshConnections({ dockerHost: 'ssh://other', directory: first.directory, environment: first.environment });
    const third = createSshConnections({ dockerHost: 'ssh://me@box:2222', directory: first.directory, environment: first.environment });
    made.push({ connections: second, base: first.base }, { connections: third, base: first.base });
    const leases = await Promise.all([first.connections, second, third].map((connections) => sharedLease(connections)));
    expect(new Set(leases.map((lease) => lease.path)).size).toBe(3);
    expect(first.masters()).toHaveLength(3);
    expect(new Set(first.masters().map(({ args }) => args[args.indexOf('-S') + 1])).size).toBe(3);
    second.close();
    third.close();
    await until(() => first.masters().filter(({ pid }) => isAlive(pid)).length === 1);
    expect((await sharedLease(first.connections)).path).toBe(leases[0].path);
  });

  it('gives each space a connection of its own, apart from the one the place is asked over', async () => {
    const { connections, masters } = stand();
    const keys = [null, 'aaaaaaaaaaaa', 'bbbbbbbbbbbb'];
    const leases = [];
    for (const key of keys) leases.push(await sharedLease(connections, key));
    expect(new Set(leases.map((lease) => lease.path)).size).toBe(3);
    expect(masters()).toHaveLength(3);
    for (const [index, key] of keys.entries()) expect((await sharedLease(connections, key)).path).toBe(leases[index].path);
  });

  it('gives up a connection a command was killed on, once the other commands on it end', async () => {
    const { connections, masters, bin } = stand();
    // Like a master whose killed command the server keeps: the end of its input alone does not end it.
    fs.writeFileSync(path.join(bin, 'ssh'), FAKE_SSH.replace('exec cat', 'cat; exec sleep 60'), { mode: 0o755 });
    const [killed, other] = await sharedLeases(connections, 2);
    killed.release({ killed: true });
    expect((await connections.lease(null)).path).not.toBe(other.path);
    expect(fs.existsSync(shim(other))).toBe(true);
    other.release();
    await until(() => !isAlive(masters()[0].pid));
  });

  it('gives nobody a connection that was given up while it was being proved', async () => {
    const { connections, clock } = stand();
    const first = await sharedLease(connections);
    clock.time += 60_000;
    const waiting = connections.lease(null);
    first.release({ killed: true });
    expect((await waiting).path).toBeNull();
  });

  it('ends a connection no command came to, once it has been idle', async () => {
    const { connections, masters } = stand({ lastIdleMs: 300 });
    expect((await connections.lease(null)).path).toBeNull();
    await until(() => masters().length === 1);
    await until(() => !isAlive(masters()[0].pid));
  });

  it('ends a connection after its last command, and not while one runs', async () => {
    const { connections, masters, clock } = stand({ lastIdleMs: 300 });
    const lease = await sharedLease(connections);
    const started = Date.now();
    await until(() => Date.now() - started > 700);
    expect(isAlive(masters()[0].pid)).toBe(true);
    clock.time += 1;
    lease.release();
    await until(() => !isAlive(masters()[0].pid));
  });

  it('shares from a folder others could write to when it lies inside one only the user enters', async () => {
    const { connections, base } = stand();
    const inner = path.join(base, 'ssh');
    fs.mkdirSync(inner);
    fs.chmodSync(inner, 0o775);
    await sharedLease(connections);
    const group = stand();
    fs.chmodSync(group.base, 0o770);
    expect((await group.connections.lease(null)).path).toBeNull();
    await settled(group.clock, group.connections);
    expect(group.spawned).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('shares nothing from a folder an ACL opens, and takes one whose ACL only denies', async () => {
    const open = stand();
    expect(spawnSync('/bin/chmod', ['+a', 'everyone allow add_file,delete_child', open.base]).status).toBe(0);
    await settled(open.clock, open.connections);
    expect(open.spawned).toEqual([]);
    spawnSync('/bin/chmod', ['-N', open.base]);
    const denied = stand();
    expect(spawnSync('/bin/chmod', ['+a', 'everyone deny delete', denied.base]).status).toBe(0);
    await sharedLease(denied.connections);
    spawnSync('/bin/chmod', ['-N', denied.base]);
  });

  it('opens a new connection after the old one dropped', async () => {
    const { connections, masters, clock } = stand();
    const before = await sharedLease(connections);
    before.release();
    process.kill(masters()[0].pid, 'SIGKILL');
    await until(() => !fs.existsSync(path.dirname(shim(before))));
    const after = await sharedLease(connections);
    expect(after.path).not.toBeNull();
    expect(after.path).not.toBe(before.path);
    expect(masters()).toHaveLength(2);
  });

  it('leaves a connection that stopped answering, after a sleep of the laptop, and uses a new one', async () => {
    const { connections, masters, clock } = stand();
    const before = await sharedLease(connections);
    before.release();
    process.kill(masters()[0].pid, 'SIGSTOP');
    clock.time += 60_000;
    expect((await connections.lease(null)).path).toBeNull();
    const after = await sharedLease(connections);
    try { process.kill(masters()[0].pid, 'SIGCONT'); } catch { /* It ended while it was stopped. */ }
    expect(after.path).not.toBeNull();
    expect(after.path).not.toBe(before.path);
    await until(() => !isAlive(masters()[0].pid));
  });

  it('leaves the command as it was when the login is refused, and tries again only after a pause', async () => {
    const { connections, spawned, bin, clock } = stand();
    fs.writeFileSync(path.join(bin, 'refuse'), '');
    expect((await connections.lease(null)).path).toBeNull();
    await until(() => spawned.length === 1 && spawned[0].exitCode === 255 && !spawned[0].stdout.readable);
    fs.rmSync(path.join(bin, 'refuse'));
    for (let round = 0; round < 3; round += 1) expect((await connections.lease(null)).path).toBeNull();
    expect(spawned).toHaveLength(1);
    clock.time += 120_000;
    await sharedLease(connections);
    expect(spawned).toHaveLength(2);
  });

  it('never holds a command back for a login that has not finished', async () => {
    const { connections, bin } = stand();
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nexec sleep 20\n', { mode: 0o755 });
    const startedAt = Date.now();
    for (let round = 0; round < 6; round += 1) expect((await connections.lease(null)).path).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it('ends a connection when the app is killed, one still carrying a command too', async () => {
    const { bin, directory, masters } = stand();
    // Like a master with a docker command on it: the end of its input alone does not end it.
    fs.writeFileSync(path.join(bin, 'ssh'), FAKE_SSH.replace('exec cat', 'cat; exec sleep 60'), { mode: 0o755 });
    const script = `const { createSshConnections } = await import(${JSON.stringify(new URL('./ssh-connections.ts', import.meta.url).href)});
      const connections = createSshConnections({ dockerHost: 'ssh://box', directory: ${JSON.stringify(directory)} });
      const ask = async () => { if ((await connections.lease(null)).path === null) setTimeout(ask, 20); else console.log('shared'); };
      void ask(); setInterval(() => {}, 1000);`;
    const app = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, stdio: ['ignore', 'pipe', 'inherit'] });
    await once(app.stdout, 'data');
    expect(masters().map(({ pid }) => isAlive(pid))).toEqual([true]);
    app.kill('SIGKILL');
    await until(() => !isAlive(masters()[0].pid));
  });

  it.each([['does not start', '/no/such/program'], ['ends early', '/bin/echo']])('shares nothing when the guard that ends the connection with a killed app %s', async (_what, program) => {
    const { connections, spawned } = stand({ spawnGuard: () => spawn(program, [], { stdio: ['pipe', 'ignore', 'ignore'] }) });
    expect((await connections.lease(null)).path).toBeNull();
    await until(() => spawned.length === 1 && spawned[0].signalCode === 'SIGTERM');
    expect((await connections.lease(null)).path).toBeNull();
  });

  it('puts the script and the socket in the checked folder itself, behind a link others could turn', async () => {
    const { base, connections, directory } = stand();
    const real = path.join(base, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, directory);
    const lease = await sharedLease(connections);
    expect(lease.path.startsWith(`${fs.realpathSync(real)}/`)).toBe(true);
  });

  it('shares nothing from a folder another user can write to', async () => {
    const { connections, base, spawned, clock } = stand();
    fs.chmodSync(base, 0o777);
    await settled(clock, connections);
    expect(spawned).toEqual([]);
  });

  it('leaves no connection and no folder behind when the place closes, and opens none after', async () => {
    const { connections, masters, directory, exits } = stand();
    await sharedLeases(connections, 5);
    expect(masters()).toHaveLength(2);
    connections.close();
    await until(() => masters().every(({ pid }) => !isAlive(pid)));
    expect((await connections.lease(null)).path).toBeNull();
    expect(masters()).toHaveLength(2);
    await until(() => fs.readdirSync(directory).length === 0);
    await until(() => exits.length === 0);
  });

  it('ends every connection when the app exits, one still carrying a command too', async () => {
    const { connections, masters, directory, exits } = stand();
    await sharedLease(connections);
    expect(exits).toHaveLength(1);
    exits[0]();
    await until(() => masters().every(({ pid }) => !isAlive(pid)));
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('removes what a killed app left, and nothing of one that runs', async () => {
    const { connections, directory } = stand();
    const gone = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();
    for (const name of [`${gone}-aaaaaa`, `${process.ppid}-bbbbbb`]) fs.mkdirSync(path.join(directory, name), { recursive: true });
    await sharedLease(connections);
    expect(fs.existsSync(path.join(directory, `${gone}-aaaaaa`))).toBe(false);
    expect(fs.existsSync(path.join(directory, `${process.ppid}-bbbbbb`))).toBe(true);
  });

  it('changes nothing on Windows, for a path no socket fits or a path the shell would read', async () => {
    const { base, environment } = stand();
    let spawned = 0;
    const spawnMaster = () => { spawned += 1; throw new Error('no process here'); };
    for (const options of [{ platform: 'win32' }, { directory: path.join(base, 'a'.repeat(100)) }, { directory: path.join(base, "it's") }, { directory: path.join(base, '%h') }, { environment: {} }]) {
      const connections = createSshConnections({ dockerHost: 'ssh://box', directory: path.join(base, 'x'), environment, spawnMaster, ...options });
      expect((await connections.lease(null)).path, JSON.stringify(options)).toBeNull();
      connections.close();
    }
    expect(spawned).toBe(0);
    expect(fs.readdirSync(base)).toEqual(['bin']);
  });
});
