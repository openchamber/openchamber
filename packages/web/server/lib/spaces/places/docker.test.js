import { describe, expect, it } from 'vitest';

import { SpaceError } from '../errors.js';
import { buildSpaceLabels, hashProjectDirectory } from '../labels.js';
import { SPACE_BASE_IMAGE, createDockerPlace } from './docker.js';
import { createFakeDocker, hardenedContainerEntry, internalNetworkEntry } from './fake-docker.js';

const OWNER = 'install-a';
const ID = 'a1b2c3d4e5f6';
const SPEC = { id: ID, name: 'Fix a=b, then c', project: hashProjectDirectory('/home/me/project'), created: '2026-09-19T10:00:00.000Z', memoryBytes: 4294967296 };

const CONTAINER = `openchamber-space-${ID}-space`;
const NETWORK = `openchamber-space-${ID}-network`;
const WORK = `openchamber-space-${ID}-volume-work`;
const HOME = `openchamber-space-${ID}-volume-home`;

const makePlace = (fake, owner = OWNER) => createDockerPlace({ runCommand: fake.runCommand, dockerPath: '/usr/bin/docker', owner, wait: fake.wait });

const labelsFor = (role, { id = ID, owner = OWNER } = {}) => buildSpaceLabels({ ...SPEC, id, role, owner });

/** Seeds for a complete space, as the fake docker stores them. */
const spaceResources = ({ id = ID, owner = OWNER, running = true } = {}) => {
  const prefix = `openchamber-space-${id}-`;
  const volumes = [`${prefix}volume-work`, `${prefix}volume-home`];
  return [
    {
      kind: 'container',
      name: `${prefix}space`,
      entry: hardenedContainerEntry({ name: `${prefix}space`, labels: labelsFor('space', { id, owner }), network: `${prefix}network`, volumes, running }),
    },
    ...volumes.map((name) => ({ kind: 'volume', name, entry: { Name: name, Labels: labelsFor('volume', { id, owner }) } })),
    { kind: 'network', name: `${prefix}network`, entry: internalNetworkEntry({ name: `${prefix}network`, labels: labelsFor('network', { id, owner }) }) },
  ];
};

const describeCall = (args) => {
  if (args[0] === 'run') return 'run setup';
  if (args[0] === 'create') return 'create space';
  const verb = ['network', 'volume'].includes(args[0]) ? `${args[0]} ${args[1]}` : args[0];
  return `${verb} ${args[args.length - 1]}`;
};

/** The calls that change something, in order, as short lines. */
const changes = (fake) => fake.calls
  .map((call) => call.args)
  .filter((args) => ['run', 'create', 'rm', 'pull', 'stop', 'start', 'exec'].includes(args[0]) || ['create', 'rm'].includes(args[1]))
  .map(describeCall);

const removals = (fake) => changes(fake).filter((line) => /(^| )rm /.test(line));

describe('docker place: check', () => {
  const placeWith = (runCommand) => createDockerPlace({ runCommand, dockerPath: '/opt/bin/docker', owner: OWNER });
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
    const fake = createFakeDocker();
    await makePlace(fake).create(SPEC);

    const spaceCreate = fake.calls.map((call) => call.args).find((args) => args[0] === 'create');
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
      '--env', 'HOME=/home/space',
      SPACE_BASE_IMAGE,
      'tail', '-f', '/dev/null',
    ]);
  });

  it('prepares the volumes with a root one-shot that has no network and one capability', async () => {
    const fake = createFakeDocker();
    await makePlace(fake).create(SPEC);

    const setupRun = fake.calls.map((call) => call.args).find((args) => args[0] === 'run' && args.includes('--rm'));
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
      'chown', '1000:1000', `/spaces/${ID}`, '/home/space',
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
        if (args[index - 1] === '--mount') expect(arg).toMatch(new RegExp(`^type=volume,src=openchamber-space-${ID}-volume-(work|home),dst=/`));
        if (args[index - 1] === '--network') expect([NETWORK, 'none']).toContain(arg);
        if (args[index - 1] === '--ipc' || args[index - 1] === '--cgroupns') expect(arg).toBe('private');
      });
    }
  });

  it('creates the network, the volumes, the one-shot and the space, and starts it last', async () => {
    const fake = createFakeDocker({ imagePresent: false });
    await makePlace(fake).create(SPEC);

    expect(changes(fake)).toEqual([
      `pull ${SPACE_BASE_IMAGE}`,
      `network create ${NETWORK}`,
      `volume create ${WORK}`,
      `volume create ${HOME}`,
      'run setup',
      'create space',
      `start ${CONTAINER}`,
    ]);
    const networkCreate = fake.calls.map((call) => call.args).find((args) => args[1] === 'create' && args[0] === 'network');
    expect(networkCreate.slice(0, 8)).toEqual([
      'network', 'create', '--driver', 'bridge', '--internal', '--ipv6=false',
      '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated',
    ]);
    expect(networkCreate).toContain('openchamber.space.role=network');
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
  const steps = [
    { step: 'pull', failAt: (args) => args[0] === 'pull', imagePresent: false, code: 'image_pull_failed', removals: [] },
    { step: 'network', failAt: isCreate('network', NETWORK), removals: [] },
    { step: 'work volume', failAt: isCreate('volume', WORK), removals: [`network rm ${NETWORK}`] },
    { step: 'home volume', failAt: isCreate('volume', HOME), removals: [`volume rm ${WORK}`, `network rm ${NETWORK}`] },
    { step: 'volume ownership', failAt: (args) => args[0] === 'run' && args.includes('--rm'), removals: [`volume rm ${WORK}`, `volume rm ${HOME}`, `network rm ${NETWORK}`] },
    {
      step: 'space container',
      failAt: (args) => args[0] === 'create',
      removals: [`rm ${CONTAINER}`, `volume rm ${WORK}`, `volume rm ${HOME}`, `network rm ${NETWORK}`],
    },
    {
      step: 'start',
      failAt: (args) => args[0] === 'start',
      removals: [`rm ${CONTAINER}`, `volume rm ${WORK}`, `volume rm ${HOME}`, `network rm ${NETWORK}`],
    },
  ];

  for (const { step, failAt, imagePresent = true, code = 'docker_command_failed', removals: expected } of steps) {
    it(`removes what it made when the ${step} step fails`, async () => {
      const fake = createFakeDocker({ failAt, imagePresent });

      await expect(makePlace(fake).create(SPEC)).rejects.toMatchObject({ code, details: { rollbackFailures: [], uncertain: false } });
      expect(removals(fake)).toEqual(expected);
      expect(fake.names()).toEqual([]);
    });
  }

  it('never starts a created container that fails verification, and removes it', async () => {
    const fake = createFakeDocker({
      alterContainer: (entry) => ({ ...entry, HostConfig: { ...entry.HostConfig, Privileged: true } }),
    });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('space_verification_failed');
    expect(error.details.original.violations.map((violation) => violation.check)).toEqual(['privileged']);
    expect(changes(fake)).not.toContain(`start ${CONTAINER}`);
    expect(fake.names()).toEqual([]);
  });

  it('reports the original error and what the rollback could not remove', async () => {
    const fake = createFakeDocker({
      failAt: (args) => (args[0] === 'run' && args.includes('--rm')) || (args[0] === 'network' && args[1] === 'rm'),
    });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('docker_command_failed');
    expect(error.message).toMatch(/docker run --rm failed/);
    expect(error.message).toMatch(new RegExp(`Clean-up also failed for: network ${NETWORK}`));
    expect(error.details.rollbackFailures).toEqual([{ kind: 'network', name: NETWORK, message: 'Error response from daemon: simulated failure' }]);
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

    const error = await createDockerPlace({ runCommand, dockerPath: 'docker', owner: OWNER }).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('image_pull_failed');
    expect(error.message).toBe(`Could not create the space. Could not download the base image: ${stderr}. Common causes: no internet access on the Docker machine, or Docker's credential helper cannot run in this session.`);
    expect(fake.names()).toEqual([]);
  });
});

describe('docker place: create rollback after a timeout', () => {
  it('sweeps again after the daemon finished the step late, including the unlabelled volumes it made', async () => {
    // The CLI of the one-shot is killed. The first sweep removes the volumes and the network.
    // Then the daemon runs the one-shot after all: it stays running and docker makes its `src=` volumes again, without labels.
    const fake = createFakeDocker({ timeoutAt: (args) => args[0] === 'run' });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe('command_timeout');
    expect(error.details).toMatchObject({ uncertain: true, rollbackFailures: [] });
    expect(error.message).toMatch(/look at the spaces list/);
    expect(removals(fake)).toEqual([
      `volume rm ${WORK}`, `volume rm ${HOME}`, `network rm ${NETWORK}`,
      `rm openchamber-space-${ID}-setup`, `volume rm ${WORK}`, `volume rm ${HOME}`,
    ]);
    expect(fake.names()).toEqual([]);
  });

  it('sweeps again after a timed-out create of the space container', async () => {
    const fake = createFakeDocker({ timeoutAt: (args) => args[0] === 'create' });

    await expect(makePlace(fake).create(SPEC)).rejects.toMatchObject({ code: 'command_timeout', details: { uncertain: true } });
    expect(fake.names()).toEqual([]);
  });

  it.each(['command_killed', 'command_output_too_large'])('treats %s like a timeout', async (code) => {
    const fake = createFakeDocker({ timeoutAt: (args) => args[0] === 'run', interruptionCode: code });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.code).toBe(code);
    expect(error.details).toMatchObject({ uncertain: true, rollbackFailures: [] });
    expect(removals(fake)).toContain(`rm openchamber-space-${ID}-setup`);
    expect(fake.names()).toEqual([]);
  });

  it('reports what the second sweep could not remove', async () => {
    const fake = createFakeDocker({
      timeoutAt: (args) => args[0] === 'run',
      failAt: (args) => args[0] === 'rm',
    });

    const error = await makePlace(fake).create(SPEC).catch((caught) => caught);
    expect(error.details.uncertain).toBe(true);
    expect(error.details.rollbackFailures.map((item) => `${item.kind} ${item.name}`)).toContain(`container openchamber-space-${ID}-setup`);
  });

  it('does not pause or sweep twice for an ordinary failure', async () => {
    const fake = createFakeDocker({ failAt: (args) => args[0] === 'create' });
    let waits = 0;
    const place = createDockerPlace({ runCommand: fake.runCommand, dockerPath: 'docker', owner: OWNER, wait: async () => { waits += 1; } });

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
      { id: ID, name: SPEC.name, project: SPEC.project, created: SPEC.created, state: 'running', orphans: [], damaged: true, missing: [NETWORK, HOME] },
    ]);
  });

  it('still lists the other spaces when a resource vanishes between the listing and the inspect', async () => {
    const fake = createFakeDocker({ resources: [...spaceResources(), ...spaceResources({ id: '111111111111' })] });
    const runCommand = async (file, args, options) => {
      const result = await fake.runCommand(file, args, options);
      // The listing still names a volume that is gone by the time of the inspect.
      return args[0] === 'volume' && args[1] === 'ls' ? { ...result, stdout: `${result.stdout}\nopenchamber-space-222222222222-volume-work` } : result;
    };

    const spaces = await createDockerPlace({ runCommand, dockerPath: 'docker', owner: OWNER }).list();
    expect(spaces.map((space) => [space.id, space.state, space.damaged])).toEqual([[ID, 'running', false], ['111111111111', 'running', false]]);
  });

  it('rejects when the inspect fails for any other reason', async () => {
    const fake = createFakeDocker({ resources: spaceResources() });
    const runCommand = async (file, args, options) => (
      args[0] === 'volume' && args[1] === 'inspect'
        ? { code: 1, stdout: '[]', stderr: 'permission denied while trying to connect to the Docker daemon socket' }
        : fake.runCommand(file, args, options)
    );

    await expect(createDockerPlace({ runCommand, dockerPath: 'docker', owner: OWNER }).list()).rejects.toMatchObject({ code: 'docker_command_failed' });
  });

  it('ignores a resource the filter returned without our labels', async () => {
    const entry = { Name: '/stray', Config: { Labels: { 'openchamber.space': 'true', 'openchamber.space.id': 'not-an-id' } }, State: { Running: true } };
    const runCommand = async (file, args) => {
      if (args[0] === 'ps') return { code: 0, stdout: 'stray\n', stderr: '' };
      if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify([entry]), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    expect(await createDockerPlace({ runCommand, dockerPath: 'docker', owner: OWNER }).list()).toEqual([]);
  });

  it('rejects when docker fails, never an empty list', async () => {
    const fake = createFakeDocker({ resources: spaceResources(), failAt: (args) => args[0] === 'ps' });
    await expect(makePlace(fake).list()).rejects.toMatchObject({ code: 'docker_command_failed' });
  });

  it('rejects when docker prints something unreadable', async () => {
    const runCommand = async (file, args) => ({ code: 0, stdout: args[0] === 'ps' ? 'one\n' : 'not json', stderr: '' });
    await expect(createDockerPlace({ runCommand, dockerPath: 'docker', owner: OWNER }).list()).rejects.toMatchObject({ code: 'docker_output_unreadable' });
  });

  it('lets a runner failure through', async () => {
    const runCommand = async () => { throw new SpaceError('command_timeout', 'too slow'); };
    await expect(createDockerPlace({ runCommand, dockerPath: 'docker', owner: OWNER }).list()).rejects.toMatchObject({ code: 'command_timeout' });
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
      { kind: 'container', name: CONTAINER },
      { kind: 'volume', name: WORK },
      { kind: 'volume', name: HOME },
      { kind: 'network', name: NETWORK },
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
    const result = await createDockerPlace({ runCommand, dockerPath: 'docker', owner: OWNER }).remove(ID);
    expect(result.failed).toEqual([]);
    expect(result.removed).toHaveLength(4);
  });

  it('treats a container that is already being removed as removed', async () => {
    const fake = createFakeDocker({ resources: spaceResources() });
    const runCommand = async (file, args, options) => (
      args[0] === 'rm'
        ? { code: 1, stdout: '', stderr: `Error response from daemon: removal of container ${CONTAINER} is already in progress` }
        : fake.runCommand(file, args, options)
    );

    const result = await createDockerPlace({ runCommand, dockerPath: 'docker', owner: OWNER }).remove(ID);
    expect(result.failed.filter((item) => item.kind === 'container')).toEqual([]);
    expect(result.removed).toContainEqual({ kind: 'container', name: CONTAINER });
  });

  it('removes the rest when one resource vanished between the listing and the inspect', async () => {
    const fake = createFakeDocker({ resources: spaceResources() });
    const runCommand = async (file, args, options) => {
      const result = await fake.runCommand(file, args, options);
      return args[0] === 'ps' ? { ...result, stdout: `${result.stdout}\nopenchamber-space-${ID}-setup` } : result;
    };

    const result = await createDockerPlace({ runCommand, dockerPath: 'docker', owner: OWNER }).remove(ID);
    expect(result.failed).toEqual([]);
    expect(fake.names()).toEqual([]);
  });

  it('reports what it could not remove and keeps going', async () => {
    const fake = createFakeDocker({ resources: spaceResources(), failAt: (args) => args[0] === 'volume' && args[1] === 'rm' && args[2] === WORK });
    const result = await makePlace(fake).remove(ID);
    expect(result.failed).toEqual([{ kind: 'volume', name: WORK, message: 'Error response from daemon: simulated failure' }]);
    expect(result.removed.map((item) => item.name)).toEqual([CONTAINER, HOME, NETWORK]);
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

  it('stops and starts the space container', async () => {
    const fake = createFakeDocker({ resources: spaceResources() });
    const place = makePlace(fake);

    await place.stop(ID);
    expect((await place.list())[0].state).toBe('exited');
    await place.start(ID);
    expect((await place.list())[0].state).toBe('running');
    expect(changes(fake)).toEqual([`stop ${CONTAINER}`, `start ${CONTAINER}`]);
  });

  it('verifies a hardened space and reports a missing network', async () => {
    const fake = createFakeDocker({ resources: spaceResources() });
    expect(await makePlace(fake).verify(ID)).toEqual([]);

    const withoutNetwork = createFakeDocker({ resources: spaceResources().filter((resource) => resource.kind !== 'network') });
    const violations = await makePlace(withoutNetwork).verify(ID);
    expect(violations.map((violation) => violation.check)).toEqual(['network_internal', 'network_host_isolation', 'network_labels']);
  });
});
