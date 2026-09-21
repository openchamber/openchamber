import { describe, expect, it } from 'vitest';

import { SpaceError } from '../errors.js';
import { GATEKEEPER_PROGRAM } from '../gatekeeper-channel.js';
import { buildSpaceLabels, buildToolsLabels, hashProjectDirectory } from '../labels.js';
import { SPACE_ENVIRONMENT, SPACE_SERVER_COMMAND } from '../layout.js';
import { createRegistryToolsSource, toolsContentKey } from '../tools.js';
import { SPACE_BASE_IMAGE, createDockerPlace } from './docker.js';
import { bridgeNetworkEntry, createFakeDocker, hardenedContainerEntry, internalNetworkEntry } from './fake-docker.js';

const OWNER = 'install-a';
const ID = 'a1b2c3d4e5f6';
const SPEC = { id: ID, name: 'Fix a=b, then c', project: hashProjectDirectory('/home/me/project'), created: '2026-09-19T10:00:00.000Z', memoryBytes: 4294967296 };

const CONTAINER = `openchamber-space-${ID}-space`;
const GATEKEEPER = `openchamber-space-${ID}-gatekeeper`;
const NETWORK = `openchamber-space-${ID}-network`;
const OUTER_NETWORK = `openchamber-space-${ID}-outer-network`;
const WORK = `openchamber-space-${ID}-volume-work`;
const HOME = `openchamber-space-${ID}-volume-home`;

const SOURCE = createRegistryToolsSource({ webVersion: '1.24.2', openCodeVersion: '1.18.31' });
const KEY = toolsContentKey(SOURCE, SPACE_BASE_IMAGE);
const TOOLS = `openchamber-tools-${OWNER}-${KEY}`;
const NOW = new Date('2026-09-20T08:00:00.000Z');

/** A place on a plain runner, for the tests that wrap or replace the fake. */
const placeOn = (runCommand, options = {}) => createDockerPlace({ runCommand, dockerPath: 'docker', owner: OWNER, toolsSource: SOURCE, now: () => NOW, ...options });

const makePlace = (fake, owner = OWNER, toolsSource = SOURCE) => placeOn(fake.runCommand, { dockerPath: '/usr/bin/docker', owner, toolsSource, wait: fake.wait, now: fake.now });

const labelsFor = (role, { id = ID, owner = OWNER } = {}) => buildSpaceLabels({ ...SPEC, id, role, owner });

const toolsLabels = ({ owner = OWNER, key = KEY, role = 'tools' } = {}) => buildToolsLabels({ role, owner, key, description: SOURCE.description, created: NOW.toISOString() });

/** Seed for a tools volume, filled unless the test says otherwise. */
const toolsResource = ({ owner = OWNER, key = KEY, filled = true, labels = toolsLabels({ owner, key }) } = {}) => {
  const name = `openchamber-tools-${owner}-${key}`;
  return { kind: 'volume', name, entry: { Name: name, Labels: labels }, filled };
};

/**
 * Seeds for a complete space, as the fake docker stores them. It runs on `tools`, its server has
 * a token, and its gatekeeper runs whenever it does.
 */
const spaceResources = ({ id = ID, owner = OWNER, running = true, tools = `openchamber-tools-${owner}-${KEY}` } = {}) => {
  const prefix = `openchamber-space-${id}-`;
  const mounts = [
    { volume: `${prefix}volume-work`, destination: `/spaces/${id}` },
    { volume: `${prefix}volume-home`, destination: '/home/space' },
    { volume: tools, destination: '/opt/openchamber-tools', readOnly: true },
  ];
  const gatekeeper = hardenedContainerEntry({
    name: `${prefix}gatekeeper`,
    labels: labelsFor('gatekeeper', { id, owner }),
    network: `${prefix}network`,
    mounts: [],
    env: ['HOME=/tmp'],
    running,
    memoryBytes: 268435456,
    tmpfs: '/tmp:rw,noexec,nosuid,size=16m',
    aliases: ['gatekeeper'],
  });
  gatekeeper.NetworkSettings.Networks[`${prefix}outer-network`] = {};
  return [
    { kind: 'container', name: `${prefix}gatekeeper`, entry: gatekeeper },
    {
      kind: 'container',
      name: `${prefix}space`,
      entry: hardenedContainerEntry({ name: `${prefix}space`, labels: labelsFor('space', { id, owner }), network: `${prefix}network`, mounts, running }),
    },
    { kind: 'volume', name: `${prefix}volume-work`, entry: { Name: `${prefix}volume-work`, Labels: labelsFor('volume', { id, owner }) } },
    { kind: 'volume', name: `${prefix}volume-home`, entry: { Name: `${prefix}volume-home`, Labels: labelsFor('volume', { id, owner }) }, token: 'seeded-token' },
    { kind: 'network', name: `${prefix}network`, entry: internalNetworkEntry({ name: `${prefix}network`, labels: labelsFor('network', { id, owner }) }) },
    { kind: 'network', name: `${prefix}outer-network`, entry: bridgeNetworkEntry({ name: `${prefix}outer-network`, labels: labelsFor('outer-network', { id, owner }) }) },
  ];
};

const roleOf = (args) => args.find((arg) => arg.startsWith('openchamber.space.role='))?.split('=')[1];
const isRun = (role) => (args) => args[0] === 'run' && roleOf(args) === role;
const isExec = (word) => (args) => args[0] === 'exec' && args.slice(5).join(' ').includes(word);

const CONTAINER_ID = /^[0-9a-f]{64}$/;

const describeCall = (args) => {
  if (args[0] === 'run') return `run ${roleOf(args)}`;
  // A container that is addressed by the id `docker create` printed, not by a name.
  if (CONTAINER_ID.test(args[args.length - 1])) return `${args[0]} <id>`;
  if (args[0] === 'create') return args.includes('--network-alias') ? 'create gatekeeper' : 'create space';
  if (args[0] === 'rename') return `rename ${args[1]} ${args[2]}`;
  if (args[0] === 'network' && args[1] === 'connect') return `network connect ${args[2]}`;
  if (isExec('ln -sfn')(args)) return 'exec link plugin';
  if (isExec('token.new')(args)) return 'exec write token';
  if (isExec('gatekeeper.cjs.new')(args)) return 'exec write program';
  if (args[0] === 'exec') return `exec ${args[4].endsWith('-gatekeeper') ? 'gatekeeper ' : ''}${args[5].split('/').pop()}`;
  const verb = ['network', 'volume'].includes(args[0]) ? `${args[0]} ${args[1]}` : args[0];
  return `${verb} ${args[args.length - 1]}`;
};

/** The calls that change something, in order, as short lines. */
const changes = (fake) => fake.calls
  .map((call) => call.args)
  .filter((args) => ['run', 'create', 'rm', 'pull', 'stop', 'start', 'exec', 'rename'].includes(args[0]) || ['create', 'rm', 'connect'].includes(args[1]))
  .map(describeCall);

/** What the gatekeeper costs at every start: its program is written into a tmpfs that a stop empties. */
const GATEKEEPER_START_STEPS = ['exec write program', 'exec gatekeeper curl'];

/** What `create` does after the tools volume is there. */
const SPACE_STEPS = [
  `network create ${NETWORK}`,
  `network create ${OUTER_NETWORK}`,
  `volume create ${WORK}`,
  `volume create ${HOME}`,
  'run setup',
  'create gatekeeper',
  `network connect ${OUTER_NETWORK}`,
  `start ${GATEKEEPER}`,
  ...GATEKEEPER_START_STEPS,
  'create space',
  `start ${CONTAINER}`,
  'exec link plugin',
  'exec write token',
  'exec curl',
];

const removals = (fake) => changes(fake).filter((line) => /(^| )rm /.test(line));

describe('docker place: check', () => {
  const placeWith = (runCommand) => placeOn(runCommand, { dockerPath: '/opt/bin/docker' });
  const SECCOMP = ['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns'];
  const engine = ({ version = '29.2.1', securityOptions = SECCOMP } = {}) => async (file, args) => {
    const answer = args[0] === 'version' ? { Client: { Version: '29.3.0' }, Server: { Version: version, Os: 'linux', Arch: 'arm64' } } : securityOptions;
    return { code: 0, stdout: JSON.stringify(answer), stderr: '' };
  };

  it('reports the server version, os and arch, and that it can isolate from the host', async () => {
    expect(await placeWith(engine()).check()).toEqual({ available: true, version: '29.2.1', os: 'linux', arch: 'arm64', hostIsolation: true });
  });

  it('flags an engine older than 28 as unable to isolate from the host', async () => {
    expect(await placeWith(engine({ version: '27.5.1' })).check()).toMatchObject({ available: true, hostIsolation: false });
  });

  it.each([
    ['no seccomp entry', ['name=apparmor']],
    ['an unconfined profile', ['name=seccomp,profile=unconfined']],
    ['no security options at all', null],
  ])('is unavailable with %s', async (title, securityOptions) => {
    const result = await placeWith(engine({ securityOptions })).check();
    expect(result).toMatchObject({ available: false, code: 'docker_seccomp_missing' });
    expect(result.message).toMatch(/seccomp/);
  });

  it('accepts the older name of the builtin seccomp profile', async () => {
    expect(await placeWith(engine({ securityOptions: ['name=seccomp,profile=default'] })).check()).toMatchObject({ available: true });
  });

  it('says the CLI is missing only when the executable does not exist', async () => {
    const place = placeWith(async () => { throw new SpaceError('command_spawn_failed', 'spawn docker ENOENT', { errno: 'ENOENT' }); });
    const result = await place.check();
    expect(result.available).toBe(false);
    expect(result.code).toBe('docker_cli_missing');
    expect(result.message).toMatch(/Install Docker/);
  });

  it('names the errno of any other spawn failure', async () => {
    const place = placeWith(async () => { throw new SpaceError('command_spawn_failed', 'spawn docker EACCES', { errno: 'EACCES' }); });
    const result = await place.check();
    expect(result.code).toBe('docker_cli_unusable');
    expect(result.message).toContain('EACCES');
    expect(result.message).toContain('/opt/bin/docker');
  });

  it('says the daemon is not running when the CLI answers without a server', async () => {
    const stdout = JSON.stringify({ Client: { Version: '29.3.0' }, Server: null });
    const place = placeWith(async () => ({ code: 1, stdout, stderr: 'Cannot connect to the Docker daemon' }));
    const result = await place.check();
    expect(result.code).toBe('docker_daemon_unreachable');
    expect(result.message).toMatch(/Start Docker Desktop or Colima/);
  });

  it('says the daemon is unreachable on a timeout', async () => {
    const place = placeWith(async () => { throw new SpaceError('command_timeout', 'too slow'); });
    expect((await place.check()).code).toBe('docker_daemon_unreachable');
  });
});

describe('docker place: create', () => {
  it('creates the space container with exactly the hardening flags', async () => {
    const fake = createFakeDocker({ resources: [toolsResource()] });
    await makePlace(fake).create(SPEC);

    const spaceCreate = fake.calls.map((call) => call.args).find((args) => args[0] === 'create' && !args.includes('--network-alias'));
    expect(spaceCreate).toEqual([
      'create',
      '--name', CONTAINER,
      '--label', 'openchamber.space=true',
      '--label', `openchamber.space.id=${ID}`,
      '--label', 'openchamber.space.role=space',
      '--label', `openchamber.space.owner=${OWNER}`,
      '--label', `openchamber.space.project=${SPEC.project}`,
      '--label', 'openchamber.space.name=Fix a=b, then c',
      '--label', 'openchamber.space.created=2026-09-19T10:00:00.000Z',
      '--init',
      '--user', '1000:1000',
      '--read-only',
      '--tmpfs', '/tmp:rw,exec,nosuid,size=256m',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--pids-limit', '512',
      '--memory', '4294967296',
      '--memory-swap', '4294967296',
      '--shm-size', '64m',
      '--ipc', 'private',
      '--cgroupns', 'private',
      '--log-driver', 'local',
      '--log-opt', 'max-size=10m',
      '--log-opt', 'max-file=1',
      '--log-opt', 'compress=false',
      '--network', NETWORK,
      '--mount', `type=volume,src=${WORK},dst=/spaces/${ID}`,
      '--mount', `type=volume,src=${HOME},dst=/home/space`,
      '--mount', `type=volume,src=${TOOLS},dst=/opt/openchamber-tools,readonly`,
      '--env', 'HOME=/home/space',
      '--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/openchamber-tools/node_modules/.bin',
      '--env', 'HTTPS_PROXY=http://gatekeeper:3128',
      '--env', 'https_proxy=http://gatekeeper:3128',
      '--env', 'HTTP_PROXY=http://gatekeeper:3128',
      '--env', 'http_proxy=http://gatekeeper:3128',
      '--env', 'NO_PROXY=gatekeeper,localhost,127.0.0.1',
      '--env', 'no_proxy=gatekeeper,localhost,127.0.0.1',
      '--env', 'NODE_USE_ENV_PROXY=1',
      '--env', 'OPENCODE_DISABLE_MODELS_FETCH=1',
      '--env', 'OPENCODE_DISABLE_AUTOUPDATE=1',
      '--env', 'OPENCHAMBER_RELAY_HOST=off',
      SPACE_BASE_IMAGE,
      '/bin/sh', '-c',
      'while [ ! -s /home/space/.openchamber-space/token ]; do /bin/sleep 0.2; done; OPENCHAMBER_UI_PASSWORD="$(/bin/cat /home/space/.openchamber-space/token)"; export OPENCHAMBER_UI_PASSWORD; exec openchamber serve --foreground --api-only --host 127.0.0.1 --port 27600',
    ]);
    expect(Object.keys(SPACE_ENVIRONMENT)).not.toContain('OPENCHAMBER_UI_PASSWORD');
    expect(SPACE_SERVER_COMMAND.join(' ')).not.toMatch(/\n/);
  });

  it('creates the gatekeeper with the hardening of a space, no mount, and a limit of its own', async () => {
    const fake = createFakeDocker({ resources: [toolsResource()] });
    await makePlace(fake).create(SPEC);

    const create = fake.calls.map((call) => call.args).find((args) => args[0] === 'create' && args.includes('--network-alias'));
    const flags = create.filter((arg, index) => create[index - 1] !== '--label' && arg !== '--label');
    expect(flags).toEqual([
      'create',
      '--name', GATEKEEPER,
      '--init',
      '--user', '1000:1000',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--pids-limit', '512',
      '--memory', '268435456',
      '--memory-swap', '268435456',
      '--shm-size', '64m',
      '--ipc', 'private',
      '--cgroupns', 'private',
      '--log-driver', 'local',
      '--log-opt', 'max-size=10m',
      '--log-opt', 'max-file=1',
      '--log-opt', 'compress=false',
      '--network', NETWORK,
      '--network-alias', 'gatekeeper',
      '--env', 'HOME=/tmp',
      SPACE_BASE_IMAGE,
      '/bin/sh', '-c',
      'while [ ! -s /tmp/openchamber-gatekeeper/gatekeeper.cjs ]; do /bin/sleep 0.2; done; exec /usr/local/bin/node /tmp/openchamber-gatekeeper/gatekeeper.cjs 0.0.0.0 3128 8080 9099 300000 128 64 8',
    ]);
    expect(create).toContain('openchamber.space.role=gatekeeper');
    expect(create).not.toContain('--mount');
    // The program travels on stdin, so it is in no argument list, and no secret is in one either.
    const write = fake.calls.find((call) => isExec('gatekeeper.cjs.new')(call.args));
    expect(write.options.stdin).toBe(GATEKEEPER_PROGRAM);
    expect(write.args[4]).toBe(GATEKEEPER);
  });

  it('starts the gatekeeper and waits for its corridor before the space container starts', async () => {
    const fake = createFakeDocker({ resources: [toolsResource()] });
    await makePlace(fake).create(SPEC);

    const steps = changes(fake);
    expect(steps.indexOf('exec gatekeeper curl')).toBeLessThan(steps.indexOf('create space'));
    expect(steps.indexOf(`start ${GATEKEEPER}`)).toBeLessThan(steps.indexOf(`start ${CONTAINER}`));
  });

  it('prepares the volumes with a root one-shot that has no network and one capability', async () => {
    const fake = createFakeDocker();
    await makePlace(fake).create(SPEC);

    const setupRun = fake.calls.map((call) => call.args).find(isRun('setup'));
    const flags = setupRun.filter((arg, index) => setupRun[index - 1] !== '--label' && arg !== '--label');
    expect(flags).toEqual([
      'run', '--rm',
      '--name', `openchamber-space-${ID}-setup`,
      '--user', '0:0',
      '--network', 'none',
      '--cap-drop', 'ALL',
      '--cap-add', 'CHOWN',
      '--security-opt', 'no-new-privileges',
      '--read-only',
      '--ipc', 'private',
      '--cgroupns', 'private',
      '--memory', '134217728',
      '--memory-swap', '134217728',
      '--log-driver', 'local',
      '--log-opt', 'max-size=10m',
      '--log-opt', 'max-file=1',
      '--log-opt', 'compress=false',
      '--mount', `type=volume,src=${WORK},dst=/spaces/${ID}`,
      '--mount', `type=volume,src=${HOME},dst=/home/space`,
      SPACE_BASE_IMAGE,
      '/bin/chown', '1000:1000', `/spaces/${ID}`, '/home/space',
    ]);
    expect(setupRun).toContain('openchamber.space.role=setup');
  });

  it('never asks docker for host paths, privileges, ports, devices or host namespaces', async () => {
    const fake = createFakeDocker({ imagePresent: false });
    await makePlace(fake).create(SPEC);

    const forbidden = ['-v', '--volume', '--privileged', '-p', '--publish', '-P', '--publish-all', '--device', '--pid', '--uts', '--userns', '--cap-add=ALL', '--volumes-from'];
    for (const { args } of fake.calls) {
      for (const flag of forbidden) {
        expect(args).not.toContain(flag);
      }
      expect(args.join(' ')).not.toContain('docker.sock');
      args.forEach((arg, index) => {
        if (args[index - 1] === '--mount') expect(arg).toMatch(new RegExp(`^type=volume,src=(openchamber-space-${ID}-volume-(work|home),dst=/|${TOOLS},dst=/opt/openchamber-tools(,readonly)?$)`));
        // Only the tools filler has a way out.
        if (args[index - 1] === '--network') expect(isRun('tools-fill')(args) ? ['bridge'] : [NETWORK, 'none']).toContain(arg);
        if (args[index - 1] === '--ipc' || args[index - 1] === '--cgroupns') expect(arg).toBe('private');
      });
    }
  });

  it('pulls the image, fills the tools, then makes the space, starts it, and waits for its server', async () => {
    const fake = createFakeDocker({ imagePresent: false });
    await makePlace(fake).create(SPEC);

    expect(changes(fake)).toEqual([
      `pull ${SPACE_BASE_IMAGE}`,
      `volume create ${TOOLS}`,
      'run tools-fill',
      'run tools-check',
      ...SPACE_STEPS,
    ]);
    const networkCreate = fake.calls.map((call) => call.args).find((args) => args[1] === 'create' && args[0] === 'network');
    expect(networkCreate.slice(0, 8)).toEqual([
      'network', 'create', '--driver', 'bridge', '--internal', '--ipv6=false',
      '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated',
    ]);
    expect(networkCreate).toContain('openchamber.space.role=network');

    // The outer network is the gatekeeper's way out, so it is an ordinary bridge and it is
    // never internal. The space is not attached to it.
    const outerCreate = fake.calls.map((call) => call.args).filter((args) => args[1] === 'create' && args[0] === 'network')[1];
    expect(outerCreate.slice(0, 5)).toEqual(['network', 'create', '--driver', 'bridge', '--ipv6=false']);
    expect(outerCreate).not.toContain('--internal');
    expect(outerCreate).toContain('openchamber.space.role=outer-network');
    expect(outerCreate[outerCreate.length - 1]).toBe(OUTER_NETWORK);
  });

  it('skips the pull when the image is present', async () => {
    const fake = createFakeDocker();
    await makePlace(fake).create(SPEC);
    expect(fake.calls.some((call) => call.args[0] === 'pull')).toBe(false);
  });

  it('gives every docker call the executable path and a timeout', async () => {
    const fake = createFakeDocker();
    await makePlace(fake).create(SPEC);
    for (const call of fake.calls) {
      expect(call.file).toBe('/usr/bin/docker');
      expect(call.options.timeoutMs).toBeGreaterThan(0);
    }
  });

  it('refuses when a resource with the same name exists, and touches nothing', async () => {
    const stranger = { kind: 'volume', name: WORK, entry: { Name: WORK, Labels: null } };
    const fake = createFakeDocker({ resources: [stranger] });

    await expect(makePlace(fake).create(SPEC)).rejects.toMatchObject({ code: 'space_name_taken' });
    expect(changes(fake)).toEqual([]);
    expect(fake.names()).toEqual([`volume:${WORK}`]);
    expect(fake.calls.some((call) => call.args[0] === 'volume' && call.args[1] === 'create')).toBe(false);
  });

  it('rejects a bad spec before calling docker', async () => {
    const fake = createFakeDocker();
    await expect(makePlace(fake).create({ ...SPEC, id: '../etc' })).rejects.toMatchObject({ code: 'invalid_space_id' });
    await expect(makePlace(fake).create({ ...SPEC, name: 'two\nlines' })).rejects.toMatchObject({ code: 'invalid_space_name' });
    await expect(makePlace(fake).create({ ...SPEC, memoryBytes: 1024 })).rejects.toMatchObject({ code: 'invalid_memory_limit' });
    await expect(makePlace(fake).create({ ...SPEC, memoryBytes: undefined })).rejects.toMatchObject({ code: 'invalid_memory_limit' });
    expect(fake.calls).toEqual([]);
  });
});

describe('docker place: create rollback', () => {
  const isCreate = (kind, name) => (args) => args[0] === kind && args[1] === 'create' && args[args.length - 1] === name;
  const networks = [`network rm ${NETWORK}`, `network rm ${OUTER_NETWORK}`];
  const withoutSpace = [`rm ${GATEKEEPER}`, `volume rm ${WORK}`, `volume rm ${HOME}`, ...networks];
  const everything = [`rm ${GATEKEEPER}`, `rm ${CONTAINER}`, `volume rm ${WORK}`, `volume rm ${HOME}`, ...networks];
  const steps = [
    { step: 'pull', failAt: (args) => args[0] === 'pull', imagePresent: false, code: 'image_pull_failed', removals: [] },
    { step: 'network', failAt: isCreate('network', NETWORK), removals: [] },
    { step: 'outer network', failAt: isCreate('network', OUTER_NETWORK), removals: [`network rm ${NETWORK}`] },
    { step: 'work volume', failAt: isCreate('volume', WORK), removals: networks },
    { step: 'home volume', failAt: isCreate('volume', HOME), removals: [`volume rm ${WORK}`, ...networks] },
    { step: 'volume ownership', failAt: isRun('setup'), removals: [`volume rm ${WORK}`, `volume rm ${HOME}`, ...networks] },
    { step: 'gatekeeper container', failAt: (args) => args[0] === 'create' && args.includes('--network-alias'), removals: withoutSpace },
    { step: 'gatekeeper network connect', failAt: (args) => args[0] === 'network' && args[1] === 'connect', removals: withoutSpace },
    { step: 'gatekeeper start', failAt: (args) => args[0] === 'start' && args[1] === GATEKEEPER, removals: withoutSpace },
    { step: 'gatekeeper program', failAt: isExec('gatekeeper.cjs.new'), code: 'gatekeeper_setup_failed', removals: withoutSpace },
    { step: 'space container', failAt: (args) => args[0] === 'create' && !args.includes('--network-alias'), removals: everything },
    { step: 'start', failAt: (args) => args[0] === 'start' && args[1] === CONTAINER, removals: everything },
    { step: 'plugin link', failAt: isExec('ln -sfn'), code: 'space_setup_failed', removals: everything },
    { step: 'token', failAt: isExec('token.new'), code: 'space_setup_failed', removals: everything },
  ];

  for (const { step, failAt, imagePresent = true, code = 'docker_command_failed', removals: expected } of steps) {
    it(`removes what it made when the ${step} step fails, and keeps the tools volume`, async () => {
      const fake = createFakeDocker({ failAt, imagePresent, resources: [toolsResource()] });

      await expect(makePlace(fake).create(SPEC)).rejects.toMatchObject({ code, details: { rollbackFailures: [], uncertain: false } });
      expect(removals(fake)).toEqual(expected);
      expect(fake.names()).toEqual([`volume:${TOOLS}`]);
    });
  }

  it('rolls everything back when the gatekeeper never answers, and never makes the space', async () => {
    // The gatekeeper starts and its control channel stays silent. Nothing of the space is made:
    // a space must never exist without a way out that the host can talk to.
    const fake = createFakeDocker({ gatekeeperReady: false, resources: [toolsResource()] });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('gatekeeper_not_ready');
    expect(error.message).toMatch(/did not become ready within 60 seconds/);
    expect(error.details).toMatchObject({ rollbackFailures: [], uncertain: false });
    expect(changes(fake)).not.toContain('create space');
    expect(removals(fake)).toEqual([`rm ${GATEKEEPER}`, `volume rm ${WORK}`, `volume rm ${HOME}`, `network rm ${NETWORK}`, `network rm ${OUTER_NETWORK}`]);
    expect(fake.names()).toEqual([`volume:${TOOLS}`]);
  });

  it('rolls the space back when its server never becomes ready, and keeps the tools volume', async () => {
    const fake = createFakeDocker({ serverReady: false, resources: [toolsResource()] });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('space_server_not_ready');
    // The fake clock moves only in `wait`, so this is the deadline and not a count of attempts.
    expect(error.message).toMatch(/did not become ready within 120 seconds/);
    expect(error.details).toMatchObject({ rollbackFailures: [], uncertain: false });
    expect(removals(fake)).toEqual(everything);
    expect(fake.names()).toEqual([`volume:${TOOLS}`]);
  });

  it('does not call a timed-out request to the server inside an interrupted Docker step', async () => {
    const fake = createFakeDocker({ resources: [toolsResource()] });
    const runCommand = async (file, args, options) => {
      if (isExec('curl')(args) && args[4] === CONTAINER) throw new SpaceError('command_timeout', 'docker exec did not finish within 13000 ms and was stopped');
      return fake.runCommand(file, args, options);
    };
    let waits = 0;
    const place = placeOn(runCommand, { now: fake.now, wait: async (milliseconds) => { waits += 1; await fake.wait(milliseconds); } });

    const error = await place.create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('space_server_not_ready');
    expect(error.details.uncertain).toBe(false);
    expect(error.message).not.toMatch(/Docker may still finish/);
    // Every wait was a pause of the readiness wait. The rollback did not pause for a second sweep.
    expect(waits).toBe(240);
    expect(fake.names()).toEqual([`volume:${TOOLS}`]);
  });

  it('never starts a created container that fails verification, and removes it', async () => {
    const fake = createFakeDocker({
      alterContainer: (entry) => (entry.Name.endsWith('-space') ? { ...entry, HostConfig: { ...entry.HostConfig, Privileged: true } } : entry),
    });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('space_verification_failed');
    expect(error.details.original.violations.map((violation) => violation.check)).toEqual(['privileged']);
    expect(changes(fake)).not.toContain(`start ${CONTAINER}`);
    expect(fake.names()).toEqual([`volume:${TOOLS}`]);
  });

  it('never starts a gatekeeper that fails verification, and never makes the space', async () => {
    const fake = createFakeDocker({
      alterContainer: (entry) => (entry.Name.endsWith('-gatekeeper') ? { ...entry, HostConfig: { ...entry.HostConfig, ReadonlyRootfs: false } } : entry),
    });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('space_verification_failed');
    expect(error.details.original.violations.map((violation) => violation.check)).toEqual(['gatekeeper_read_only']);
    expect(changes(fake)).not.toContain(`start ${GATEKEEPER}`);
    expect(changes(fake)).not.toContain('create space');
    expect(fake.names()).toEqual([`volume:${TOOLS}`]);
  });

  it('reports the original error and what the rollback could not remove', async () => {
    const fake = createFakeDocker({
      failAt: (args) => isRun('setup')(args) || (args[0] === 'network' && args[1] === 'rm'),
    });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('docker_command_failed');
    expect(error.message).toMatch(/docker run --rm failed/);
    expect(error.message).toMatch(new RegExp(`Clean-up also failed for: network ${NETWORK}`));
    expect(error.details.rollbackFailures).toEqual([
      { kind: 'network', name: NETWORK, message: 'Error response from daemon: simulated failure' },
      { kind: 'network', name: OUTER_NETWORK, message: 'Error response from daemon: simulated failure' },
    ]);
    expect(error.cause.code).toBe('docker_command_failed');
  });
});

describe('docker place: image pull', () => {
  it('puts what docker said first and stays neutral about the cause', async () => {
    const fake = createFakeDocker({ imagePresent: false });
    const stderr = 'error getting credentials - err: exit status 1, out: `A specified logon session does not exist.`';
    const runCommand = async (file, args, options) => (
      args[0] === 'pull' ? { code: 1, stdout: '', stderr: `${stderr}\n` } : fake.runCommand(file, args, options)
    );

    const error = await placeOn(runCommand).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('image_pull_failed');
    expect(error.message).toBe(`Could not create the space. Could not download the base image: ${stderr}. Common causes: no internet access on the Docker machine, or Docker's credential helper cannot run in this session.`);
    expect(fake.names()).toEqual([]);
  });
});

describe('docker place: create rollback after a timeout', () => {
  it('sweeps again after the daemon finished the step late, including the unlabelled volumes it made', async () => {
    // The CLI of the one-shot is killed. The first sweep removes the volumes and the network.
    // Then the daemon runs the one-shot after all: it stays running and docker makes its `src=` volumes again, without labels.
    const fake = createFakeDocker({ timeoutAt: isRun('setup'), resources: [toolsResource()] });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('command_timeout');
    expect(error.details).toMatchObject({ uncertain: true, rollbackFailures: [] });
    expect(error.message).toMatch(/look at the spaces list/);
    expect(removals(fake)).toEqual([
      `volume rm ${WORK}`, `volume rm ${HOME}`, `network rm ${NETWORK}`, `network rm ${OUTER_NETWORK}`,
      `rm openchamber-space-${ID}-setup`, `volume rm ${WORK}`, `volume rm ${HOME}`,
    ]);
    expect(fake.names()).toEqual([`volume:${TOOLS}`]);
  });

  it('sweeps again after a timed-out create of the space container', async () => {
    const fake = createFakeDocker({ timeoutAt: (args) => args[0] === 'create', resources: [toolsResource()] });

    await expect(makePlace(fake).create(SPEC)).rejects.toMatchObject({ code: 'command_timeout', details: { uncertain: true } });
    expect(fake.names()).toEqual([`volume:${TOOLS}`]);
  });

  it.each(['command_killed', 'command_output_too_large'])('treats %s like a timeout', async (code) => {
    const fake = createFakeDocker({ timeoutAt: isRun('setup'), interruptionCode: code, resources: [toolsResource()] });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe(code);
    expect(error.details).toMatchObject({ uncertain: true, rollbackFailures: [] });
    expect(removals(fake)).toContain(`rm openchamber-space-${ID}-setup`);
    expect(fake.names()).toEqual([`volume:${TOOLS}`]);
  });

  it('reports what the second sweep could not remove', async () => {
    const fake = createFakeDocker({
      timeoutAt: isRun('setup'),
      failAt: (args) => args[0] === 'rm',
      resources: [toolsResource()],
    });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.details.uncertain).toBe(true);
    expect(error.details.rollbackFailures.map((item) => `${item.kind} ${item.name}`)).toContain(`container openchamber-space-${ID}-setup`);
  });

  it('does not pause or sweep twice for an ordinary failure', async () => {
    const fake = createFakeDocker({ failAt: (args) => args[0] === 'create', resources: [toolsResource()] });
    let waits = 0;
    const place = placeOn(fake.runCommand, { wait: async () => { waits += 1; } });

    await expect(place.create(SPEC)).rejects.toMatchObject({ details: { uncertain: false } });
    expect(waits).toBe(0);
  });
});

describe('docker place: list', () => {
  it('builds spaces from labels, with state and orphans', async () => {
    const orphanId = 'ffffffffffff';
    const orphanVolume = `openchamber-space-${orphanId}-volume-work`;
    const fake = createFakeDocker({
      resources: [
        ...spaceResources(),
        ...spaceResources({ id: '111111111111', running: false }),
        { kind: 'volume', name: orphanVolume, entry: { Name: orphanVolume, Labels: labelsFor('volume', { id: orphanId }) } },
        ...spaceResources({ id: '222222222222', owner: 'install-b' }),
        { kind: 'container', name: 'openchamber-space-333333333333-space', entry: { Name: '/openchamber-space-333333333333-space', Config: { Labels: {} }, State: { Running: true } } },
      ],
    });

    const spaces = await makePlace(fake).list();
    expect(spaces).toEqual([
      { id: ID, name: SPEC.name, project: SPEC.project, created: SPEC.created, state: 'running', orphans: [], damaged: false, missing: [] },
      { id: '111111111111', name: SPEC.name, project: SPEC.project, created: SPEC.created, state: 'exited', orphans: [], damaged: false, missing: [] },
      { id: orphanId, name: SPEC.name, project: SPEC.project, created: SPEC.created, state: 'missing', orphans: [{ kind: 'volume', name: orphanVolume }], damaged: false, missing: [] },
    ]);
  });

  it('flags a space whose network or volume is gone, and names what is missing', async () => {
    const fake = createFakeDocker({ resources: spaceResources().filter((resource) => resource.name !== HOME && resource.kind !== 'network') });

    expect(await makePlace(fake).list()).toEqual([
      { id: ID, name: SPEC.name, project: SPEC.project, created: SPEC.created, state: 'running', orphans: [], damaged: true, missing: [NETWORK, OUTER_NETWORK, HOME] },
    ]);
  });

  it('flags a running space whose gatekeeper is gone, or does not run, as damaged and not as missing', async () => {
    const withoutGatekeeper = createFakeDocker({ resources: spaceResources().filter((resource) => resource.name !== GATEKEEPER) });
    expect(await makePlace(withoutGatekeeper).list()).toEqual([
      { id: ID, name: SPEC.name, project: SPEC.project, created: SPEC.created, state: 'running', orphans: [], damaged: true, missing: [GATEKEEPER] },
    ]);

    // The space runs and its way out does not. For the space that is as good as no gatekeeper.
    const seeds = spaceResources();
    seeds.find((resource) => resource.name === GATEKEEPER).entry.State.Running = false;
    const stoppedGatekeeper = createFakeDocker({ resources: seeds });
    expect(await makePlace(stoppedGatekeeper).list()).toMatchObject([{ state: 'running', damaged: true, missing: [GATEKEEPER] }]);

    // A stopped space with a stopped gatekeeper is whole: `start` brings both up in order.
    const bothStopped = createFakeDocker({ resources: spaceResources({ running: false }) });
    expect(await makePlace(bothStopped).list()).toMatchObject([{ state: 'exited', damaged: false, missing: [] }]);
  });

  it('still lists the other spaces when a resource vanishes between the listing and the inspect', async () => {
    const fake = createFakeDocker({ resources: [...spaceResources(), ...spaceResources({ id: '111111111111' })] });
    const runCommand = async (file, args, options) => {
      const result = await fake.runCommand(file, args, options);
      // The listing still names a volume that is gone by the time of the inspect.
      return args[0] === 'volume' && args[1] === 'ls' ? { ...result, stdout: `${result.stdout}\nopenchamber-space-222222222222-volume-work` } : result;
    };

    const spaces = await placeOn(runCommand).list();
    expect(spaces.map((space) => [space.id, space.state, space.damaged])).toEqual([[ID, 'running', false], ['111111111111', 'running', false]]);
  });

  it('rejects when the inspect fails for any other reason', async () => {
    const fake = createFakeDocker({ resources: spaceResources() });
    const runCommand = async (file, args, options) => (
      args[0] === 'volume' && args[1] === 'inspect'
        ? { code: 1, stdout: '[]', stderr: 'permission denied while trying to connect to the Docker daemon socket' }
        : fake.runCommand(file, args, options)
    );

    await expect(placeOn(runCommand).list()).rejects.toMatchObject({ code: 'docker_command_failed' });
  });

  it('ignores a resource the filter returned without our labels', async () => {
    const entry = { Name: '/stray', Config: { Labels: { 'openchamber.space': 'true', 'openchamber.space.id': 'not-an-id' } }, State: { Running: true } };
    const runCommand = async (file, args) => {
      if (args[0] === 'ps') return { code: 0, stdout: 'stray\n', stderr: '' };
      if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify([entry]), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    expect(await placeOn(runCommand).list()).toEqual([]);
  });

  it('rejects when docker fails, never an empty list', async () => {
    const fake = createFakeDocker({ resources: spaceResources(), failAt: (args) => args[0] === 'ps' });
    await expect(makePlace(fake).list()).rejects.toMatchObject({ code: 'docker_command_failed' });
  });

  it('rejects when docker prints something unreadable', async () => {
    const runCommand = async (file, args) => ({ code: 0, stdout: args[0] === 'ps' ? 'one\n' : 'not json', stderr: '' });
    await expect(placeOn(runCommand).list()).rejects.toMatchObject({ code: 'docker_output_unreadable' });
  });

  it('lets a runner failure through', async () => {
    const runCommand = async () => { throw new SpaceError('command_timeout', 'too slow'); };
    await expect(placeOn(runCommand).list()).rejects.toMatchObject({ code: 'command_timeout' });
  });
});

describe('docker place: remove', () => {
  it('removes only resources with our marker, this id and this owner', async () => {
    const unlabelled = `openchamber-space-${ID}-volume-cache`;
    const fake = createFakeDocker({
      resources: [
        ...spaceResources(),
        { kind: 'volume', name: unlabelled, entry: { Name: unlabelled, Labels: null } },
        { kind: 'volume', name: 'other-install', entry: { Name: 'other-install', Labels: labelsFor('volume', { owner: 'install-b' }) } },
        ...spaceResources({ id: '111111111111' }),
      ],
    });

    const result = await makePlace(fake).remove(ID);
    expect(result.failed).toEqual([]);
    expect(result.removed).toEqual([
      { kind: 'container', name: GATEKEEPER },
      { kind: 'container', name: CONTAINER },
      { kind: 'volume', name: WORK },
      { kind: 'volume', name: HOME },
      { kind: 'network', name: NETWORK },
      { kind: 'network', name: OUTER_NETWORK },
    ]);
    expect(fake.names()).toEqual([
      `volume:${unlabelled}`,
      'volume:other-install',
      ...spaceResources({ id: '111111111111' }).map((resource) => `${resource.kind}:${resource.name}`),
    ]);
  });

  it('treats a resource that vanished meanwhile as removed', async () => {
    const fake = createFakeDocker({ resources: spaceResources() });
    const runCommand = async (file, args, options) => {
      if (args[0] === 'volume' && args[1] === 'rm') {
        return { code: 1, stdout: '', stderr: `Error response from daemon: get ${args[2]}: no such volume` };
      }
      return fake.runCommand(file, args, options);
    };
    const result = await placeOn(runCommand).remove(ID);
    expect(result.failed).toEqual([]);
    expect(result.removed).toHaveLength(6);
  });

  it('treats a container that is already being removed as removed', async () => {
    const fake = createFakeDocker({ resources: spaceResources() });
    const runCommand = async (file, args, options) => (
      args[0] === 'rm'
        ? { code: 1, stdout: '', stderr: `Error response from daemon: removal of container ${CONTAINER} is already in progress` }
        : fake.runCommand(file, args, options)
    );

    const result = await placeOn(runCommand).remove(ID);
    expect(result.failed.filter((item) => item.kind === 'container')).toEqual([]);
    expect(result.removed).toContainEqual({ kind: 'container', name: CONTAINER });
  });

  it('removes the rest when one resource vanished between the listing and the inspect', async () => {
    const fake = createFakeDocker({ resources: spaceResources() });
    const runCommand = async (file, args, options) => {
      const result = await fake.runCommand(file, args, options);
      return args[0] === 'ps' ? { ...result, stdout: `${result.stdout}\nopenchamber-space-${ID}-setup` } : result;
    };

    const result = await placeOn(runCommand).remove(ID);
    expect(result.failed).toEqual([]);
    expect(fake.names()).toEqual([]);
  });

  it('reports what it could not remove and keeps going', async () => {
    const fake = createFakeDocker({ resources: spaceResources(), failAt: (args) => args[0] === 'volume' && args[1] === 'rm' && args[2] === WORK });
    const result = await makePlace(fake).remove(ID);
    expect(result.failed).toEqual([{ kind: 'volume', name: WORK, message: 'Error response from daemon: simulated failure' }]);
    expect(result.removed.map((item) => item.name)).toEqual([GATEKEEPER, CONTAINER, HOME, NETWORK, OUTER_NETWORK]);
  });

  it('is a no-op for a space that does not exist', async () => {
    const fake = createFakeDocker();
    expect(await makePlace(fake).remove(ID)).toEqual({ removed: [], failed: [] });
  });

  it('rejects when docker cannot list', async () => {
    const fake = createFakeDocker({ resources: spaceResources(), failAt: (args) => args[0] === 'volume' && args[1] === 'ls' });
    await expect(makePlace(fake).remove(ID)).rejects.toMatchObject({ code: 'docker_command_failed' });
  });
});

describe('docker place: exec, stop, start, verify', () => {
  it('execs argv as the space user with stdin and a timeout', async () => {
    const fake = createFakeDocker({ resources: spaceResources() });
    const result = await makePlace(fake).exec(ID, ['id', '-u'], { stdin: 'input', timeoutMs: 5000 });

    expect(result).toEqual({ code: 0, stdout: '1000\n', stderr: '' });
    const call = fake.calls[fake.calls.length - 1];
    expect(call.args).toEqual(['exec', '--interactive', '--user', '1000:1000', CONTAINER, 'id', '-u']);
    expect(call.options).toEqual({ stdin: 'input', timeoutMs: 5000 });
  });

  it('rejects an empty command', async () => {
    const fake = createFakeDocker({ resources: spaceResources() });
    await expect(makePlace(fake).exec(ID, [])).rejects.toMatchObject({ code: 'invalid_command' });
  });

  it('refuses a container with our name that lacks our labels', async () => {
    const entry = hardenedContainerEntry({ name: CONTAINER, labels: {}, network: NETWORK, volumes: [] });
    const fake = createFakeDocker({ resources: [{ kind: 'container', name: CONTAINER, entry }] });
    const place = makePlace(fake);

    await expect(place.exec(ID, ['id'])).rejects.toMatchObject({ code: 'space_not_ours' });
    await expect(place.stop(ID)).rejects.toMatchObject({ code: 'space_not_ours' });
    await expect(place.start(ID)).rejects.toMatchObject({ code: 'space_not_ours' });
    await expect(place.verify(ID)).rejects.toMatchObject({ code: 'space_not_ours' });
    expect(changes(fake)).toEqual([]);
  });

  it('refuses a space of another installation', async () => {
    const fake = createFakeDocker({ resources: spaceResources({ owner: 'install-b' }) });
    await expect(makePlace(fake).stop(ID)).rejects.toMatchObject({ code: 'space_not_ours' });
  });

  it('says when the space does not exist', async () => {
    await expect(makePlace(createFakeDocker()).start(ID)).rejects.toMatchObject({ code: 'space_not_found' });
  });

  it('stops the space, starts the same container again, and waits for its server', async () => {
    const fake = createFakeDocker({ resources: [toolsResource(), ...spaceResources()] });
    const place = makePlace(fake);

    await place.stop(ID);
    expect((await place.list())[0].state).toBe('exited');
    await place.start(ID);
    expect((await place.list())[0].state).toBe('running');
    // The space stops before its gatekeeper and starts after it, so it never runs without one.
    expect(changes(fake)).toEqual([
      `stop ${CONTAINER}`,
      `stop ${GATEKEEPER}`,
      'run tools-check',
      `start ${GATEKEEPER}`,
      ...GATEKEEPER_START_STEPS,
      `start ${CONTAINER}`,
      'exec curl',
    ]);
    expect(fake.token(CONTAINER)).toBe('seeded-token');
  });

  it('refuses to start a space whose gatekeeper is gone, and starts nothing', async () => {
    const fake = createFakeDocker({
      resources: [toolsResource(), ...spaceResources({ running: false }).filter((resource) => resource.name !== GATEKEEPER)],
    });

    await expect(makePlace(fake).start(ID)).rejects.toMatchObject({ code: 'gatekeeper_missing' });
    expect(changes(fake)).not.toContain(`start ${CONTAINER}`);
  });

  it('runs a command in the gatekeeper when the caller asks for that target, and nowhere else', async () => {
    const fake = createFakeDocker({ resources: spaceResources() });
    const place = makePlace(fake);

    await place.exec(ID, ['id', '-u'], { target: 'gatekeeper' });
    expect(fake.calls[fake.calls.length - 1].args.slice(0, 6)).toEqual(['exec', '--interactive', '--user', '1000:1000', GATEKEEPER, 'id']);

    await expect(place.exec(ID, ['id'], { target: 'setup' })).rejects.toMatchObject({ code: 'invalid_exec_target' });
    const withoutGatekeeper = createFakeDocker({ resources: spaceResources().filter((resource) => resource.name !== GATEKEEPER) });
    await expect(makePlace(withoutGatekeeper).exec(ID, ['id'], { target: 'gatekeeper' })).rejects.toMatchObject({ code: 'gatekeeper_missing' });
  });

  it('leaves a running space alone when asked to start it, and still looks after its gatekeeper', async () => {
    const fake = createFakeDocker({ resources: [toolsResource({ key: 'ffffffffffffffff' }), ...spaceResources({ tools: `openchamber-tools-${OWNER}-ffffffffffffffff` })] });

    await makePlace(fake).start(ID);
    // The space's own container and its tools are untouched. Its way out is not its container.
    expect(changes(fake)).toEqual(GATEKEEPER_START_STEPS);
  });

  it('brings back a gatekeeper that died under a space that still runs, without touching the space', async () => {
    const seeds = spaceResources();
    // What an agent can force: the gatekeeper is killed for its memory and the space runs on.
    seeds.find((resource) => resource.name === GATEKEEPER).entry.State.Running = false;
    const fake = createFakeDocker({ resources: [toolsResource(), ...seeds] });
    const place = makePlace(fake);

    expect(await place.list()).toMatchObject([{ state: 'running', damaged: true, missing: [GATEKEEPER] }]);
    await place.start(ID);

    expect(changes(fake)).toEqual([`start ${GATEKEEPER}`, ...GATEKEEPER_START_STEPS]);
    expect(await place.list()).toMatchObject([{ state: 'running', damaged: false, missing: [] }]);
  });

  it('rejects a start whose server never becomes ready, and leaves the space as it is', async () => {
    const fake = createFakeDocker({ serverReady: false, resources: [toolsResource(), ...spaceResources({ running: false })] });

    await expect(makePlace(fake).start(ID)).rejects.toMatchObject({ code: 'space_server_not_ready' });
    expect(removals(fake)).toEqual([]);
  });

  it('verifies a hardened space and reports a missing network', async () => {
    const fake = createFakeDocker({ resources: [toolsResource(), ...spaceResources()] });
    expect(await makePlace(fake).verify(ID)).toEqual([]);

    const withoutNetwork = createFakeDocker({ resources: [toolsResource(), ...spaceResources().filter((resource) => resource.kind !== 'network')] });
    const violations = await makePlace(withoutNetwork).verify(ID);
    expect(violations.map((violation) => violation.check)).toEqual([
      'network_internal', 'network_host_isolation', 'network_labels', 'gatekeeper_outer_network_labels',
    ]);
  });

  it('verifies the gatekeeper too, and says when a space has none', async () => {
    const withoutGatekeeper = createFakeDocker({ resources: [toolsResource(), ...spaceResources().filter((resource) => resource.name !== GATEKEEPER)] });
    expect((await makePlace(withoutGatekeeper).verify(ID)).map((violation) => violation.check)).toEqual(['gatekeeper_missing']);

    // A gatekeeper that lost a network, or that anyone could reach the tools of.
    const seeds = spaceResources();
    const gatekeeper = seeds.find((resource) => resource.name === GATEKEEPER).entry;
    delete gatekeeper.NetworkSettings.Networks[OUTER_NETWORK];
    gatekeeper.Mounts = [{ Type: 'volume', Name: TOOLS, Source: '/x', Destination: '/opt/openchamber-tools', RW: true }];
    const changed = createFakeDocker({ resources: [toolsResource(), ...seeds] });
    expect((await makePlace(changed).verify(ID)).map((violation) => violation.check)).toEqual(['gatekeeper_mounts', 'gatekeeper_networks']);
  });

  it('reports a space whose tools volume lost its labels', async () => {
    const fake = createFakeDocker({ resources: [toolsResource({ labels: null }), ...spaceResources()] });
    expect((await makePlace(fake).verify(ID)).map((violation) => violation.check)).toEqual(['tools_labels']);
  });
});

describe('docker place: tools volume', () => {
  const OTHER_KEY = '0123456789abcdef';
  const fillCalls = (fake) => fake.calls.filter((call) => isRun('tools-fill')(call.args));

  it('reuses a filled volume of this owner and this key', async () => {
    const fake = createFakeDocker({ resources: [toolsResource()] });
    await makePlace(fake).create(SPEC);

    expect(changes(fake)).toEqual(['run tools-check', ...SPACE_STEPS]);
  });

  it('fills a new volume with labels, a hardened one-shot, and the input on stdin', async () => {
    const fake = createFakeDocker();
    await makePlace(fake).create(SPEC);

    const volumeCreate = fake.calls.map((call) => call.args).find((args) => args[0] === 'volume' && args[1] === 'create' && args[args.length - 1] === TOOLS);
    expect(volumeCreate).toEqual([
      'volume', 'create',
      '--label', 'openchamber.space=true',
      '--label', 'openchamber.space.role=tools',
      '--label', `openchamber.space.owner=${OWNER}`,
      '--label', `openchamber.space.tools.key=${KEY}`,
      '--label', 'openchamber.space.tools.description=web 1.24.2, opencode 1.18.31',
      '--label', 'openchamber.space.created=2026-09-20T08:00:00.000Z',
      TOOLS,
    ]);

    const [fill] = fillCalls(fake);
    const flags = fill.args.filter((arg, index) => fill.args[index - 1] !== '--label' && arg !== '--label');
    expect(flags.slice(0, -5)).toEqual([
      'run', '--rm', '--interactive',
      '--name', `${TOOLS}-fill`,
      '--init',
      '--user', '0:0',
      '--network', 'bridge',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--read-only',
      '--tmpfs', '/tmp:rw,exec,nosuid,size=1g',
      '--pids-limit', '512',
      '--ipc', 'private',
      '--cgroupns', 'private',
      '--memory', '2147483648',
      '--memory-swap', '2147483648',
      '--log-driver', 'local',
      '--log-opt', 'max-size=10m',
      '--log-opt', 'max-file=1',
      '--log-opt', 'compress=false',
      '--mount', `type=volume,src=${TOOLS},dst=/opt/openchamber-tools`,
      '--env', 'HOME=/tmp',
      SPACE_BASE_IMAGE,
    ]);
    expect(flags.slice(-5, -3)).toEqual(['/usr/local/bin/node', '-e']);
    expect(flags.slice(-2)).toEqual(['/opt/openchamber-tools', '/tmp/openchamber-fill']);
    expect(fill.args).toContain('openchamber.space.role=tools-fill');
    expect(fill.args).not.toContain('--cap-add');

    // A fill may take minutes, so it has a timeout and an output cap of its own.
    expect(fill.options.timeoutMs).toBe(30 * 60_000);
    expect(fill.options.maxOutputBytes).toBe(16 * 1024 * 1024);
    const input = fill.options.stdin;
    expect(Buffer.isBuffer(input)).toBe(true);
    const header = JSON.parse(input.subarray(0, input.indexOf(10)).toString('utf8'));
    expect(header).toEqual({ key: KEY, files: [{ name: 'package.json', bytes: Buffer.byteLength(SOURCE.packageJson) }] });
    expect(input.subarray(input.indexOf(10) + 1).toString('utf8')).toBe(SOURCE.packageJson);
  });

  it('checks the fill marker without a network, read-only, as the space user', async () => {
    const fake = createFakeDocker({ resources: [toolsResource()] });
    await makePlace(fake).create(SPEC);

    const check = fake.calls.map((call) => call.args).find(isRun('tools-check'));
    const flags = check.filter((arg, index) => check[index - 1] !== '--label' && arg !== '--label');
    expect(flags).toEqual([
      'run', '--rm',
      '--name', `${TOOLS}-check`,
      '--user', '1000:1000',
      '--network', 'none',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--read-only',
      '--ipc', 'private',
      '--cgroupns', 'private',
      '--memory', '134217728',
      '--memory-swap', '134217728',
      '--log-driver', 'local',
      '--log-opt', 'max-size=10m',
      '--log-opt', 'max-file=1',
      '--log-opt', 'compress=false',
      '--mount', `type=volume,src=${TOOLS},dst=/opt/openchamber-tools,readonly`,
      SPACE_BASE_IMAGE,
      '/bin/sh', '-c', '[ -f "$1" ] || exit 42; /bin/cat "$1"', 'sh', '/opt/openchamber-tools/.filled',
    ]);
  });

  it('names every program that the host runs in a container by its absolute path in the image', async () => {
    // The space PATH starts with the npm .bin of the tools volume. A package there that ships a bin
    // named curl or sh must never be what the host runs.
    const fake = createFakeDocker();
    const place = makePlace(fake);
    await place.create(SPEC);
    await place.stop(ID);
    await place.start(ID);

    const programs = fake.calls.map((call) => call.args).flatMap((args) => {
      if (args[0] === 'exec') return [args[5]];
      if (args[0] === 'run' || args[0] === 'create') return [args[args.indexOf(SPACE_BASE_IMAGE) + 1]];
      return [];
    });
    expect([...new Set(programs)].sort()).toEqual(['/bin/chown', '/bin/sh', '/usr/bin/curl', '/usr/local/bin/node']);
    // The fixed scripts take their own commands from the image too.
    const scripts = fake.calls.map((call) => call.args).filter((args) => args[0] === 'exec' && args[5] === '/bin/sh').map((args) => args[7]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script.startsWith('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin;')).toBe(true);
  });

  it('keeps newlines out of every argument, because Docker Desktop on Windows was never verified with one', async () => {
    const fake = createFakeDocker();
    await makePlace(fake).create(SPEC);

    for (const { args } of fake.calls) {
      for (const arg of args) expect(arg).not.toMatch(/[\r\n]/);
    }
  });

  it('removes the filler and the volume when the fill fails, and makes no space', async () => {
    const fake = createFakeDocker({ failAt: isRun('tools-fill') });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('tools_fill_failed');
    expect(error.message).toMatch(/Installing web 1.24.2, opencode 1.18.31 failed: .*simulated failure/);
    expect(error.message).toMatch(/npm registry/);
    expect(error.details).toMatchObject({ uncertain: false, rollbackFailures: [] });
    expect(removals(fake)).toEqual([`volume rm ${TOOLS}`]);
    expect(fake.names()).toEqual([]);
  });

  it('sweeps again when the fill was interrupted, and removes the late filler and the volume it made again', async () => {
    const fake = createFakeDocker({ timeoutAt: isRun('tools-fill') });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('command_timeout');
    expect(error.details.uncertain).toBe(true);
    expect(error.cause.details).toEqual({ uncertain: true, rollbackFailures: [] });
    expect(removals(fake)).toEqual([`volume rm ${TOOLS}`, `rm ${TOOLS}-fill`, `volume rm ${TOOLS}`]);
    expect(fake.names()).toEqual([]);
  });

  it('fills again when a volume of ours has no marker, because that fill was interrupted', async () => {
    const leftover = { kind: 'container', name: `${TOOLS}-fill`, entry: { Name: `/${TOOLS}-fill`, Config: { Labels: toolsLabels({ role: 'tools-fill' }) }, Mounts: [], State: { Running: true } } };
    const fake = createFakeDocker({ resources: [toolsResource({ filled: false }), leftover] });
    await makePlace(fake).create(SPEC);

    expect(changes(fake).slice(0, 6)).toEqual([
      `rm ${TOOLS}-fill`,
      'run tools-check',
      `volume rm ${TOOLS}`,
      `volume create ${TOOLS}`,
      'run tools-fill',
      'run tools-check',
    ]);
    expect(await makePlace(fake).verify(ID)).toEqual([]);
  });

  it.each([
    ['no labels', null],
    ['the labels of another installation', toolsLabels({ owner: 'install-b' })],
    ['another key in its labels', toolsLabels({ key: OTHER_KEY })],
    ['the labels of a filler', toolsLabels({ role: 'tools-fill' })],
  ])('refuses a volume with our name and %s, and touches nothing', async (title, labels) => {
    const fake = createFakeDocker({ resources: [toolsResource({ labels })] });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('tools_volume_not_ours');
    expect(error.message).toContain(TOOLS);
    expect(changes(fake)).toEqual([]);
    expect(fake.names()).toEqual([`volume:${TOOLS}`]);
  });

  it('rejects when the docker CLI cannot reach the daemon for the marker check, and never takes its exit code 1 for a missing marker', async () => {
    const fake = createFakeDocker({ failAt: isRun('tools-check'), resources: [toolsResource(), ...spaceResources()] });
    const place = makePlace(fake);

    const error = await place.create({ ...SPEC, id: '111111111111' }).catch((caught) => caught);
    expect(error.code).toBe('docker_command_failed');
    expect(error.message).toMatch(/failed to connect to the docker API/);
    expect(removals(fake)).toEqual([]);
    expect(fake.calls.some((call) => isRun('tools-fill')(call.args))).toBe(false);
    expect(fake.names()).toContain(`volume:${TOOLS}`);
  });

  describe.each([
    ['a marker for other content', 'ffffffffffffffff'],
    ['an empty marker, as a crash of the Docker machine right after a fill can leave it', ''],
  ])('%s', (title, marker) => {
    // The first check finds the wrong marker. Later checks see what the fake really holds.
    const wrongOnce = (fake) => {
      let answered = false;
      return async (file, args, options) => {
        if (isRun('tools-check')(args) && !answered) {
          answered = true;
          return { code: 0, stdout: `${marker}\n`, stderr: '' };
        }
        return fake.runCommand(file, args, options);
      };
    };

    it('removes the volume and fills again when no container mounts it', async () => {
      const fake = createFakeDocker({ resources: [toolsResource()] });
      await placeOn(wrongOnce(fake), { wait: fake.wait, now: fake.now }).create(SPEC);

      // The wrong answer came from the wrapper, so the fake saw what followed it.
      expect(changes(fake).slice(0, 4)).toEqual([`volume rm ${TOOLS}`, `volume create ${TOOLS}`, 'run tools-fill', 'run tools-check']);
      expect(await makePlace(fake).verify(ID)).toEqual([]);
    });

    it('rejects when spaces still mount it, and says in plain words what frees it', async () => {
      const fake = createFakeDocker({ resources: [toolsResource(), ...spaceResources()] });
      const place = placeOn(wrongOnce(fake), { wait: fake.wait, now: fake.now });

      const error = await place.create({ ...SPEC, id: '111111111111' }).catch((caught) => caught);
      expect(error.code).toBe('tools_marker_mismatch');
      expect(error.message).toMatch(/Apply or discard the work in the spaces that were made with web 1\.24\.2, opencode 1\.18\.31, remove those spaces, then try again/);
      // Nobody needs a terminal for this, so the message names no docker command.
      expect(error.message).not.toMatch(/docker |volume rm/);
      expect(fake.calls.some((call) => isRun('tools-fill')(call.args))).toBe(false);
      expect(fake.names()).toContain(`volume:${TOOLS}`);
    });
  });

  it.each([2, 125, 126, 127, 137])('rejects exit code %i of the marker check and keeps the volume', async (code) => {
    const fake = createFakeDocker({ resources: [toolsResource()] });
    const runCommand = async (file, args, options) => (
      isRun('tools-check')(args) ? { code, stdout: '', stderr: 'something went wrong' } : fake.runCommand(file, args, options)
    );

    await expect(placeOn(runCommand, { wait: fake.wait, now: fake.now }).create(SPEC)).rejects.toMatchObject({ code: 'docker_command_failed' });
    expect(fake.names()).toEqual([`volume:${TOOLS}`]);
  });

  describe('a tools volume that another process pruned between ensure and create', () => {
    // Docker makes a missing `src=` volume again at `docker create`, without labels.
    const pruneBeforeCreate = (fake, replacement = null) => async (file, args, options) => {
      if (args[0] === 'create') {
        await fake.runCommand(file, ['volume', 'rm', TOOLS], options);
        if (replacement) await fake.runCommand(file, ['volume', 'create', ...replacement, TOOLS], options);
      }
      return fake.runCommand(file, args, options);
    };

    it('removes the unlabelled volume by name when the create fails, so the owner is not stuck for good', async () => {
      const fake = createFakeDocker({ resources: [toolsResource()] });
      const place = placeOn(pruneBeforeCreate(fake), { wait: fake.wait, now: fake.now });

      const error = await place.create(SPEC).catch((caught) => caught);
      expect(error.code).toBe('space_verification_failed');
      expect(error.details.original.violations.map((violation) => violation.check)).toEqual(['tools_labels']);
      expect(error.details.rollbackFailures).toEqual([]);
      expect(fake.names()).toEqual([]);

      // The next create fills again and works.
      await makePlace(fake).create(SPEC);
      expect(await makePlace(fake).verify(ID)).toEqual([]);
    });

    it('never removes a volume with labels, not even labels of someone else', async () => {
      const fake = createFakeDocker({ resources: [toolsResource()] });
      const place = placeOn(pruneBeforeCreate(fake, ['--label', 'com.example.owner=someone-else']), { wait: fake.wait, now: fake.now });

      await expect(place.create(SPEC)).rejects.toMatchObject({ code: 'space_verification_failed' });
      expect(fake.names()).toEqual([`volume:${TOOLS}`]);
    });

    it('does the same when a move to new tools fails', async () => {
      const oldTools = `openchamber-tools-${OWNER}-0123456789abcdef`;
      const fake = createFakeDocker({ resources: [toolsResource(), toolsResource({ key: '0123456789abcdef' }), ...spaceResources({ running: false, tools: oldTools })] });
      const place = placeOn(pruneBeforeCreate(fake), { wait: fake.wait, now: fake.now });

      await expect(place.start(ID)).rejects.toMatchObject({ code: 'space_verification_failed', details: { rollbackFailures: [] } });
      expect(fake.names()).not.toContain(`volume:${TOOLS}`);
      expect(fake.names()).toContain(`container:${CONTAINER}`);
    });
  });

  it('shares one fill between two creates that run at the same time', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fake = createFakeDocker({ beforeFill: () => gate });
    const place = makePlace(fake);

    const both = Promise.all([place.create(SPEC), place.create({ ...SPEC, id: '111111111111' })]);
    // Both creates are waiting for the tools by now, and only one of them runs the filler.
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    release();
    await both;

    expect(fillCalls(fake)).toHaveLength(1);
    expect((await place.list()).map((space) => space.state)).toEqual(['running', 'running']);
  });

  it('fills again after a failed fill, so one failure does not stick', async () => {
    let failures = 1;
    const fake = createFakeDocker({ failAt: (args) => isRun('tools-fill')(args) && failures-- > 0 });
    const place = makePlace(fake);

    await expect(place.create(SPEC)).rejects.toMatchObject({ code: 'tools_fill_failed' });
    await place.create(SPEC);
    expect(fillCalls(fake)).toHaveLength(2);
  });

  it('removes older tools volumes after a new fill, keeps one that a space still mounts, and leaves other owners alone', async () => {
    const inUse = `openchamber-tools-${OWNER}-${OTHER_KEY}`;
    const unused = toolsResource({ key: 'aaaaaaaaaaaaaaaa' });
    const foreign = toolsResource({ owner: 'install-b', key: OTHER_KEY });
    const fake = createFakeDocker({
      resources: [toolsResource({ key: OTHER_KEY }), unused, foreign, ...spaceResources({ id: '111111111111', tools: inUse })],
    });
    await makePlace(fake).create(SPEC);

    expect(fake.names()).toContain(`volume:${inUse}`);
    expect(fake.names()).not.toContain(`volume:${unused.name}`);
    expect(fake.names()).toContain(`volume:${foreign.name}`);
    expect(fake.names()).toContain(`volume:${TOOLS}`);
  });

  it('does not list a tools volume as a space, and does not remove it with one', async () => {
    const fake = createFakeDocker({ resources: [toolsResource(), ...spaceResources()] });
    const place = makePlace(fake);

    expect((await place.list()).map((space) => space.id)).toEqual([ID]);
    await place.remove(ID);
    expect(fake.names()).toEqual([`volume:${TOOLS}`]);
  });

  it('rejects a place without a tools source', () => {
    expect(() => createDockerPlace({ runCommand: async () => {}, dockerPath: 'docker', owner: OWNER })).toThrow(expect.objectContaining({ code: 'invalid_tools_source' }));
  });
});

describe('docker place: server token', () => {
  it('writes a fresh token over stdin after the start, and keeps it out of every argument', async () => {
    const fake = createFakeDocker({ resources: [toolsResource()] });
    await makePlace(fake).create(SPEC);

    const token = fake.token(CONTAINER);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const write = fake.calls.find((call) => isExec('token.new')(call.args));
    expect(write.options.stdin).toBe(token);
    expect(fake.calls.indexOf(write)).toBeGreaterThan(fake.calls.findIndex((call) => call.args[0] === 'start'));
    for (const { args } of fake.calls) {
      expect(args.join(' ')).not.toContain(token);
    }
  });

  it('gives every space a token of its own', async () => {
    const fake = createFakeDocker({ resources: [toolsResource()] });
    const place = makePlace(fake);
    await place.create(SPEC);
    await place.create({ ...SPEC, id: '111111111111' });

    expect(fake.token('openchamber-space-111111111111-space')).not.toBe(fake.token(CONTAINER));
  });
});

describe('docker place: new tools at the next start', () => {
  const OLD_KEY = '0123456789abcdef';
  const OLD_TOOLS = `openchamber-tools-${OWNER}-${OLD_KEY}`;
  const ASIDE = `${CONTAINER}-old`;
  // The gatekeeper start comes before the space start, so a test that fails "the start" must say which.
  const isSpaceStart = (args) => args[0] === 'start' && args[1] !== GATEKEEPER;
  const stoppedOnOldTools = () => [toolsResource({ key: OLD_KEY }), ...spaceResources({ running: false, tools: OLD_TOOLS })];
  const toolsOf = async (fake, name = CONTAINER) => {
    const result = await fake.runCommand('docker', ['inspect', '--type', 'container', name], {});
    return JSON.parse(result.stdout)[0]?.Mounts.find((mount) => mount.Destination === '/opt/openchamber-tools').Name;
  };

  it('makes the container again on the current tools, with the same labels, memory and token', async () => {
    const fake = createFakeDocker({ resources: stoppedOnOldTools() });
    const place = makePlace(fake);
    await place.start(ID);

    expect(changes(fake)).toEqual([
      `volume create ${TOOLS}`,
      'run tools-fill',
      'run tools-check',
      // The old tools volume is still mounted by the stopped space, so Docker keeps it.
      `volume rm ${OLD_TOOLS}`,
      // The gatekeeper is up before the space container is made again. It mounts no tools
      // volume, so the move itself leaves it alone.
      `start ${GATEKEEPER}`,
      ...GATEKEEPER_START_STEPS,
      `rename ${CONTAINER} ${ASIDE}`,
      'create space',
      'start <id>',
      'exec curl',
      `rm ${ASIDE}`,
      `volume rm ${OLD_TOOLS}`,
    ]);
    expect(await toolsOf(fake)).toBe(TOOLS);
    expect(fake.names()).not.toContain(`volume:${OLD_TOOLS}`);
    expect(fake.token(CONTAINER)).toBe('seeded-token');
    expect(await place.verify(ID)).toEqual([]);
    expect(await place.list()).toEqual([
      { id: ID, name: SPEC.name, project: SPEC.project, created: SPEC.created, state: 'running', orphans: [], damaged: false, missing: [] },
    ]);
    const create = fake.calls.map((call) => call.args).find((args) => args[0] === 'create');
    expect(create[create.indexOf('--memory') + 1]).toBe('4294967296');
  });

  it('puts the old container back when the start of the new one fails', async () => {
    const fake = createFakeDocker({ failAt: isSpaceStart, resources: [toolsResource(), ...stoppedOnOldTools()] });
    const place = makePlace(fake);

    const error = await place.start(ID).catch((caught) => caught);
    expect(error.code).toBe('docker_command_failed');
    expect(error.message).toMatch(/The space keeps its old container\./);
    expect(error.details.rollbackFailures).toEqual([]);
    expect(await toolsOf(fake)).toBe(OLD_TOOLS);
    expect(fake.names()).not.toContain(`container:${ASIDE}`);
    expect(fake.names()).toContain(`volume:${OLD_TOOLS}`);
  });

  it('removes nothing when the create fails, and puts the old container back', async () => {
    const fake = createFakeDocker({ resources: [toolsResource(), ...stoppedOnOldTools()] });
    const runCommand = async (file, args, options) => (
      args[0] === 'create' ? { code: 1, stdout: '', stderr: 'Error response from daemon: simulated failure' } : fake.runCommand(file, args, options)
    );

    const error = await placeOn(runCommand, { wait: fake.wait, now: fake.now }).start(ID).catch((caught) => caught);
    expect(error.message).toMatch(/The space keeps its old container\./);
    expect(removals(fake)).toEqual([]);
    expect(await toolsOf(fake)).toBe(OLD_TOOLS);
  });

  it('removes nothing by name when a failed create left a container behind, says so, and repairs it at the next start', async () => {
    let failures = 1;
    const fake = createFakeDocker({ failAt: (args) => args[0] === 'create' && failures-- > 0, resources: [toolsResource(), ...stoppedOnOldTools()] });
    const place = makePlace(fake);

    // There is no id to remove by, so the leftover keeps the plain name and the old container stays aside.
    const error = await place.start(ID).catch((caught) => caught);
    expect(error.code).toBe('docker_command_failed');
    expect(removals(fake)).toEqual([]);
    expect(error.details.rollbackFailures).toEqual([{ kind: 'container', name: ASIDE, message: expect.stringContaining('already in use') }]);
    expect(error.message).toMatch(/Start the space again to repair it/);
    expect(await toolsOf(fake, ASIDE)).toBe(OLD_TOOLS);

    await place.start(ID);
    expect(await toolsOf(fake)).toBe(TOOLS);
    expect(fake.names().filter((name) => name.startsWith('container:')).sort()).toEqual([`container:${GATEKEEPER}`, `container:${CONTAINER}`].sort());
  });

  it('puts the old container back when the new one fails verification, and never starts it', async () => {
    const fake = createFakeDocker({
      alterContainer: (entry) => (entry.Name.endsWith('-space') ? { ...entry, HostConfig: { ...entry.HostConfig, Privileged: true } } : entry),
      resources: [toolsResource(), ...stoppedOnOldTools()],
    });

    await expect(makePlace(fake).start(ID)).rejects.toMatchObject({ code: 'space_verification_failed' });
    expect(changes(fake).filter((line) => line.startsWith('start'))).toEqual([`start ${GATEKEEPER}`]);
    expect(await toolsOf(fake)).toBe(OLD_TOOLS);
  });

  it('puts the old container back when the new server never becomes ready', async () => {
    const fake = createFakeDocker({ serverReady: false, resources: [toolsResource(), ...stoppedOnOldTools()] });

    await expect(makePlace(fake).start(ID)).rejects.toMatchObject({ code: 'space_server_not_ready' });
    expect(await toolsOf(fake)).toBe(OLD_TOOLS);
    expect(fake.names()).not.toContain(`container:${ASIDE}`);
  });

  it('reports what it could not put back', async () => {
    const fake = createFakeDocker({
      failAt: (args) => args[0] === 'create' || (args[0] === 'rename' && args[1] === ASIDE),
      resources: [toolsResource(), ...stoppedOnOldTools()],
    });

    const error = await makePlace(fake).start(ID).catch((caught) => caught);
    expect(error.details.rollbackFailures).toEqual([{ kind: 'container', name: ASIDE, message: expect.stringContaining('simulated failure') }]);
    // The message must not promise what did not happen.
    expect(error.message).not.toMatch(/keeps its old container/);
    expect(error.message).toMatch(new RegExp(`Putting the old container back failed for: container ${ASIDE}\\. Start the space again`));
  });

  it('removes the new container by the id that create printed, never by name', async () => {
    const fake = createFakeDocker({ failAt: isSpaceStart, resources: [toolsResource(), ...stoppedOnOldTools()] });

    await expect(makePlace(fake).start(ID)).rejects.toMatchObject({ code: 'docker_command_failed' });
    const removed = fake.calls.map((call) => call.args).filter((args) => args[0] === 'rm').map((args) => args[args.length - 1]);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(CONTAINER_ID);
  });

  // The defect of the first 1b draft: the rollback removed the plain name, and the plain
  // name had gone back to the old container in the meantime. The space lost its only container.
  it('keeps the old container when it got its name back before the create landed', async () => {
    const fake = createFakeDocker({ resources: [toolsResource(), ...stoppedOnOldTools()] });
    const oldId = JSON.parse((await fake.runCommand('docker', ['inspect', '--type', 'container', CONTAINER], {})).stdout)[0].Id;
    // Another process repairs the move right after the rename, before this create.
    const runCommand = async (file, args, options) => {
      if (args[0] === 'create') await fake.runCommand(file, ['rename', ASIDE, CONTAINER], options);
      return fake.runCommand(file, args, options);
    };

    const error = await placeOn(runCommand, { wait: fake.wait, now: fake.now }).start(ID).catch((caught) => caught);
    expect(error.code).toBe('docker_command_failed');
    expect(error.message).toMatch(/is already in use/);
    expect(removals(fake)).toEqual([]);
    // The old container is back under its name, so nothing is left to repair.
    expect(error.details.rollbackFailures).toEqual([]);
    const survivor = JSON.parse((await fake.runCommand('docker', ['inspect', '--type', 'container', CONTAINER], {})).stdout)[0];
    expect(survivor.Id).toBe(oldId);
    expect(await toolsOf(fake)).toBe(OLD_TOOLS);
  });

  it('shares one run between two starts of the same space, so a container is never moved twice at once', async () => {
    const fake = createFakeDocker({ resources: stoppedOnOldTools() });
    const place = makePlace(fake);

    await Promise.all([place.start(ID), place.start(ID)]);
    expect(changes(fake).filter((line) => line.startsWith('rename') || line === 'create space')).toEqual([`rename ${CONTAINER} ${ASIDE}`, 'create space']);
    expect((await place.list())[0].state).toBe('running');
  });

  it('makes a stop wait for a start of the same space that is under way, so a stopped space stays stopped', async () => {
    const fake = createFakeDocker({ resources: [toolsResource(), ...stoppedOnOldTools()] });
    let place;
    let stopping;
    // The stop arrives between the create and the start of the move.
    const runCommand = async (file, args, options) => {
      if (isSpaceStart(args)) stopping = place.stop(ID);
      return fake.runCommand(file, args, options);
    };
    place = placeOn(runCommand, { wait: fake.wait, now: fake.now });

    await place.start(ID);
    await stopping;
    expect(changes(fake).slice(-5)).toEqual(['exec curl', `rm ${ASIDE}`, `volume rm ${OLD_TOOLS}`, `stop ${CONTAINER}`, `stop ${GATEKEEPER}`]);
    expect((await place.list())[0].state).toBe('exited');
  });

  it('stops after a start that failed, too', async () => {
    const fake = createFakeDocker({ serverReady: false, resources: [toolsResource(), ...spaceResources({ running: false })] });
    const place = makePlace(fake);

    const [started] = await Promise.allSettled([place.start(ID), place.stop(ID)]);
    expect(started.status).toBe('rejected');
    expect((await place.list())[0].state).toBe('exited');
  });

  it('does not rename anything from verify or exec while a move is under way, and says to start the space', async () => {
    const fake = createFakeDocker({ resources: [toolsResource(), ...stoppedOnOldTools()] });
    let place;
    const during = [];
    // Between the rename and the create of a move, other operations look at the space.
    const runCommand = async (file, args, options) => {
      if (args[0] === 'create') {
        for (const operation of [() => place.verify(ID), () => place.exec(ID, ['id'])]) {
          during.push(await operation().catch((caught) => caught.code));
        }
        during.push((await place.list()).map((space) => space.state));
      }
      return fake.runCommand(file, args, options);
    };
    place = placeOn(runCommand, { wait: fake.wait, now: fake.now });
    await place.start(ID);

    expect(during).toEqual(['space_move_unfinished', 'space_move_unfinished', ['exited']]);
    expect(changes(fake).filter((line) => line.startsWith('rename'))).toEqual([`rename ${CONTAINER} ${ASIDE}`]);
    expect(await toolsOf(fake)).toBe(TOOLS);
  });

  it('never moves a running space, whatever tools it runs on', async () => {
    const fake = createFakeDocker({ resources: [toolsResource({ key: OLD_KEY }), ...spaceResources({ tools: OLD_TOOLS })] });

    await makePlace(fake).start(ID);
    // Only its gatekeeper is looked after. The space container and its tools are untouched.
    expect(changes(fake)).toEqual(GATEKEEPER_START_STEPS);
    expect(await toolsOf(fake)).toBe(OLD_TOOLS);
  });

  describe('after the process died in the middle of a move', () => {
    const asAside = (resource) => (resource.name === CONTAINER ? { ...resource, name: ASIDE, entry: { ...resource.entry, Name: `/${ASIDE}` } } : resource);

    it('lists the space as stopped, refuses to read or stop it without changing anything, and repairs it at the next start', async () => {
      const fake = createFakeDocker({ resources: [toolsResource(), ...spaceResources({ running: false }).map(asAside)] });
      const place = makePlace(fake);

      expect(await place.list()).toMatchObject([{ id: ID, state: 'exited', orphans: [] }]);
      for (const operation of [() => place.verify(ID), () => place.exec(ID, ['id']), () => place.stop(ID)]) {
        const error = await operation().catch((caught) => caught);
        expect(error.code).toBe('space_move_unfinished');
        expect(error.message).toMatch(/Start the space to repair it/);
      }
      expect(changes(fake)).toEqual([]);

      await place.start(ID);
      expect(changes(fake)).toEqual([
        `rename ${ASIDE} ${CONTAINER}`, 'run tools-check', `start ${GATEKEEPER}`, ...GATEKEEPER_START_STEPS, `start ${CONTAINER}`, 'exec curl',
      ]);
    });

    it('drops an unfinished new container by its id and goes back to the old one before it starts', async () => {
      const unfinished = spaceResources({ running: false }).filter((resource) => resource.kind === 'container');
      const fake = createFakeDocker({ resources: [toolsResource(), ...stoppedOnOldTools().map(asAside), ...unfinished] });
      const place = makePlace(fake);

      expect(await place.list()).toHaveLength(1);
      await place.start(ID);
      expect(changes(fake).slice(0, 2)).toEqual(['rm <id>', `rename ${ASIDE} ${CONTAINER}`]);
      expect(await toolsOf(fake)).toBe(TOOLS);
      expect(fake.names()).not.toContain(`container:${ASIDE}`);
    });

    it('removes the unfinished container without force, and takes a container that another process started meanwhile for a started space', async () => {
      const unfinished = spaceResources({ running: false }).filter((resource) => resource.kind === 'container');
      const fake = createFakeDocker({ resources: [toolsResource(), ...stoppedOnOldTools().map(asAside), ...unfinished] });
      // The other process starts its new container between this process's inspect and its removal.
      const runCommand = async (file, args, options) => {
        if (args[0] === 'rm') await fake.runCommand(file, ['start', CONTAINER], options);
        return fake.runCommand(file, args, options);
      };

      await placeOn(runCommand, { wait: fake.wait, now: fake.now }).start(ID);

      const removal = fake.calls.map((call) => call.args).find((args) => args[0] === 'rm');
      expect(removal).not.toContain('--force');
      expect(removal[removal.length - 1]).toMatch(CONTAINER_ID);
      // Docker refused, so the running container is still there, and nothing else was touched.
      expect(fake.names()).toContain(`container:${CONTAINER}`);
      expect(changes(fake).filter((line) => line.startsWith('rename') || line === 'create space')).toEqual([]);
      expect((await makePlace(fake).list())[0].state).toBe('running');
    });

    it('rejects when the unfinished container cannot be removed and is not running either', async () => {
      const unfinished = spaceResources({ running: false }).filter((resource) => resource.kind === 'container');
      const fake = createFakeDocker({ failAt: (args) => args[0] === 'rm', resources: [toolsResource(), ...stoppedOnOldTools().map(asAside), ...unfinished] });

      await expect(makePlace(fake).start(ID)).rejects.toMatchObject({ code: 'space_recreate_failed' });
      expect(changes(fake).filter((line) => line.startsWith('rename'))).toEqual([]);
    });

    it('says that the space is gone when its container vanishes during the repair', async () => {
      const fake = createFakeDocker({ resources: [toolsResource(), ...stoppedOnOldTools().map(asAside)] });
      const runCommand = async (file, args, options) => {
        const result = await fake.runCommand(file, args, options);
        // Someone removes the space right after the rename of the repair.
        if (args[0] === 'rename') await fake.runCommand(file, ['rm', '--force', CONTAINER], options);
        return result;
      };

      const error = await placeOn(runCommand, { wait: fake.wait, now: fake.now }).start(ID).catch((caught) => caught);
      expect(error).toBeInstanceOf(SpaceError);
      expect(error.code).toBe('space_not_found');
    });

    it('leaves a running container alone and keeps the leftover aside container for `remove`', async () => {
      const running = spaceResources().filter((resource) => resource.kind === 'container');
      const fake = createFakeDocker({ resources: [toolsResource(), ...stoppedOnOldTools().map(asAside), ...running] });

      await makePlace(fake).start(ID);
      expect(changes(fake)).toEqual(GATEKEEPER_START_STEPS);
    });

    it('removes both containers with the space', async () => {
      const unfinished = spaceResources({ running: false }).filter((resource) => resource.kind === 'container');
      const fake = createFakeDocker({ resources: [toolsResource(), ...stoppedOnOldTools().map(asAside), ...unfinished] });

      const result = await makePlace(fake).remove(ID);
      expect(result.failed).toEqual([]);
      expect(fake.names().filter((name) => name.startsWith('container:'))).toEqual([]);
    });
  });
});
