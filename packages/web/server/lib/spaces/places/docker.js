import net from 'node:net';

import { SpaceError } from '../errors.js';
import { createGatekeeperChannel } from '../gatekeeper-channel.js';
import {
  buildGatekeeperCreateArgs,
  buildGatekeeperNetworkArgs,
  buildSpaceCreateArgs,
  buildSpaceNetworkArgs,
  buildVolumeOwnershipRunArgs,
  findGatekeeperHardeningViolations,
  findHardeningViolations,
  requireMemoryBytes,
} from '../hardening.js';
import {
  ROLE_GATEKEEPER,
  ROLE_NETWORK,
  ROLE_OUTER_NETWORK,
  ROLE_SETUP,
  ROLE_SPACE,
  ROLE_VOLUME,
  buildSpaceLabels,
  labelArgs,
  labelFilterArgs,
  parseSpaceLabels,
  requireOwner,
  requireSpaceId,
  spaceResourceName,
} from '../labels.js';
import { SPACE_CONNECT_COMMAND, SPACE_IDLE_EXIT_CODE, SPACE_USER, TOOLS_MOUNT_PATH } from '../layout.js';
import { openCommandStream as openCommandStreamProcess } from '../run-command.js';
import { START_CONFIG_VARIABLE } from '../space-opencode.js';
import { createSpaceServerChannel, createSpaceToken } from '../space-server.js';
import { CHANGE_TIMEOUT_MS, ROLLBACK_SETTLE_MS, createDockerEngine, entryLabels, entryName, isInterrupted, pause } from './docker-engine.js';
import { createDockerDisk } from './docker-disk.js';
import { createDockerTools } from './docker-tools.js';

const DOCKER_PLACE_ID = 'docker';
export const DOCKER_SSH_PLACE_ID = 'docker-ssh';

export const SPACE_BASE_IMAGE = 'node@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0';
export const RETIRED_SPACE_BASE_IMAGES = ['node@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844'];

const CHECK_TIMEOUT_MS = 10_000;
const PULL_TIMEOUT_MS = 20 * 60_000;
const EXEC_TIMEOUT_MS = 60_000;
const HOST_ISOLATION_MIN_ENGINE = 28;
const REMOTE_DAEMON_DOWN = /Cannot connect to the Docker daemon|Is the docker daemon running/i;
const REMOTE_DOCKER_MISSING = /docker: (?:command )?not found|No such file or directory/i;
const LOCAL_SOCKET_DENIED = /permission denied while trying to connect to the docker daemon/i;
const machineOf = (dockerHost) => String(dockerHost).replace(/^[a-z]+:\/\//i, '');
const ASIDE_SUFFIX = 'old';

const KINDS = ['container', 'volume', 'network'];

function startConfigOf(container) {
  const prefix = `${START_CONFIG_VARIABLE}=`;
  const entry = (container?.Config?.Env ?? []).find((candidate) => String(candidate).startsWith(prefix));
  return entry === undefined ? null : String(entry).slice(prefix.length);
}

function execRole(target) {
  if (target === undefined || target === ROLE_SPACE) {
    return ROLE_SPACE;
  }
  if (target === ROLE_GATEKEEPER) {
    return ROLE_GATEKEEPER;
  }
  throw new SpaceError('invalid_exec_target', `A command runs in the space or in its gatekeeper, not in '${target}'`);
}

export function createDockerPlace({ runCommand, openCommandStream = openCommandStreamProcess, dockerPath, dockerHost = null, id = DOCKER_PLACE_ID, colimaPath = null, owner, toolsSource, wait = pause, now = () => new Date() }) {
  requireOwner(owner);

  const engine = createDockerEngine({ runCommand, dockerPath, dockerHost });
  const machine = dockerHost === null ? null : machineOf(dockerHost);
  const { run, docker, inspect, removeOne, removeStoppedContainer } = engine;
  const tools = createDockerTools({ engine, owner, toolsSource, image: SPACE_BASE_IMAGE, now, wait });
  let imagePull = null;
  let imagePullFailure = null;
  const imagePullState = () => ({ pulling: imagePull !== null, failure: imagePullFailure });
  const disk = createDockerDisk({ engine, runCommand, colimaPath, owner, image: SPACE_BASE_IMAGE, retiredImages: RETIRED_SPACE_BASE_IMAGES, tools, imagePullState });

  const findResources = async (spaceId) => {
    const filters = labelFilterArgs({ owner, spaceId });
    const resources = [];
    for (const kind of KINDS) {
      for (const entry of await engine.findByLabel(kind, filters)) {
        const labels = parseSpaceLabels(entryLabels(kind, entry));
        if (labels && labels.owner === owner && (spaceId === null || labels.id === spaceId)) {
          resources.push({ kind, name: entryName(entry), labels, entry });
        }
      }
    }
    return resources;
  };

  const inspectOwnContainer = async (spaceId, name) => {
    const entry = await inspect('container', name);
    if (!entry) {
      return null;
    }
    const labels = parseSpaceLabels(entry.Config?.Labels);
    if (labels?.id !== spaceId || labels?.owner !== owner) {
      throw new SpaceError('space_not_ours', `Container ${name} exists but this OpenChamber installation did not create it`);
    }
    return entry;
  };

  const requireSpaceContainer = async (spaceId) => {
    const name = spaceResourceName(spaceId, ROLE_SPACE);
    const entry = await inspectOwnContainer(spaceId, name);
    if (entry) {
      return entry;
    }
    if (await inspectOwnContainer(spaceId, spaceResourceName(spaceId, ROLE_SPACE, ASIDE_SUFFIX))) {
      throw new SpaceError('space_move_unfinished', `Space ${spaceId} is in the middle of a move to new tools, or a move did not finish. Start the space to repair it.`);
    }
    throw new SpaceError('space_not_found', `Space ${spaceId} has no container in Docker`);
  };

  const check = async () => {
    const unavailable = (code, message) => ({ available: false, code, message });
    let version;
    let info;
    try {
      version = await run(['version', '--format', '{{json .}}'], CHECK_TIMEOUT_MS);
      info = await run(['info', '--format', '{{json .SecurityOptions}}'], CHECK_TIMEOUT_MS);
    } catch (error) {
      if (error.code === 'command_spawn_failed' && error.details?.errno === 'ENOENT') {
        return unavailable('docker_cli_missing', 'The docker command was not found. Install Docker Desktop, Colima or Docker Engine, then try again.');
      }
      if (error.code === 'command_spawn_failed') {
        return unavailable('docker_cli_unusable', `The docker command could not be started (${error.details?.errno ?? 'unknown error'}). Check that ${dockerPath} is a program this user may run.`);
      }
      if (error.code === 'command_timeout') {
        return machine === null
          ? unavailable('docker_daemon_unreachable', 'Docker did not answer in time. Restart Docker Desktop or Colima, then try again.')
          : unavailable('place_unreachable', `${machine} did not answer. Check that it is on and reachable over SSH.`);
      }
      throw error;
    }
    let server = null;
    let securityOptions = [];
    try {
      server = JSON.parse(version.stdout).Server ?? null;
      securityOptions = JSON.parse(info.stdout) ?? [];
    } catch {
      server = null;
    }
    if (version.code !== 0 || info.code !== 0 || !server) {
      if (machine === null && LOCAL_SOCKET_DENIED.test(`${version.stderr}\n${info.stderr}`)) {
        return unavailable('docker_permission_denied', 'Docker is running, but this user may not use it. Add the user to the docker group, sign in again, then try again.');
      }
      if (machine === null) {
        return unavailable('docker_daemon_unreachable', 'Docker is installed but not running. Start Docker Desktop or Colima, then try again.');
      }
      const said = `${version.stderr}\n${info.stderr}`;
      if (REMOTE_DAEMON_DOWN.test(said)) return unavailable('docker_daemon_unreachable', `Docker is not running on ${machine}. Start it there, then try again.`);
      if (REMOTE_DOCKER_MISSING.test(said)) return unavailable('docker_cli_missing', `Docker is not installed on ${machine}. Install Docker Engine there, then try again.`);
      return unavailable('place_unreachable', `Could not reach ${machine} over SSH. Check the connection, then try again.`);
    }
    if (!securityOptions.some((option) => /^name=seccomp,profile=(builtin|default)$/.test(option))) {
      return unavailable('docker_seccomp_missing', 'This Docker engine runs containers without its builtin seccomp profile. Turn seccomp back on in the Docker daemon settings, then try again.');
    }

    return {
      available: true,
      version: server.Version,
      os: server.Os,
      arch: server.Arch,
      hostIsolation: Number.parseInt(server.Version, 10) >= HOST_ISOLATION_MIN_ENGINE,
    };
  };

  const pullImage = () => {
    if (imagePull === null) {
      imagePull = run(['pull', SPACE_BASE_IMAGE], PULL_TIMEOUT_MS)
        .then((result) => {
          if (result.code !== 0) {
            throw new SpaceError(
              'image_pull_failed',
              `Could not download the base image: ${result.stderr.trim() || `exit code ${result.code}`}. Common causes: no internet access on the Docker machine, or Docker's credential helper cannot run in this session.`,
            );
          }
          imagePullFailure = null;
        })
        .catch((error) => {
          imagePullFailure = { code: error.code ?? 'image_pull_failed', message: error.message };
          throw error;
        })
        .finally(() => { imagePull = null; });
    }
    return imagePull;
  };

  const ensureImage = async (onPull = () => {}) => {
    const present = await inspect('image', SPACE_BASE_IMAGE);
    if (present) {
      return;
    }
    onPull();
    await pullImage();
  };

  const verifyContainer = async (spaceId, container) => {
    const network = await inspect('network', spaceResourceName(spaceId, ROLE_NETWORK));
    const toolsMount = (container.Mounts ?? []).find((mount) => mount.Destination === TOOLS_MOUNT_PATH);
    const toolsVolume = toolsMount?.Name ? await inspect('volume', toolsMount.Name) : null;
    return findHardeningViolations({ spaceId, owner, container, network, toolsVolume });
  };

  const verifyGatekeeperContainer = async (spaceId, container) => {
    const outerNetwork = await inspect('network', spaceResourceName(spaceId, ROLE_OUTER_NETWORK));
    return findGatekeeperHardeningViolations({ spaceId, owner, container, outerNetwork });
  };

  const verify = async (spaceId) => {
    const violations = await verifyContainer(spaceId, await requireSpaceContainer(spaceId));
    const gatekeeperContainer = await inspectOwnContainer(spaceId, spaceResourceName(spaceId, ROLE_GATEKEEPER));
    if (!gatekeeperContainer) {
      return [...violations, { check: 'gatekeeper_missing', message: 'The space has no gatekeeper container' }];
    }
    return [...violations, ...(await verifyGatekeeperContainer(spaceId, gatekeeperContainer))];
  };

  const requireNoViolations = (violations, what) => {
    if (violations.length > 0) {
      throw new SpaceError(
        'space_verification_failed',
        `The new ${what} does not match the requested restrictions: ${violations.map((violation) => violation.message).join('; ')}`,
        { violations },
      );
    }
  };

  const requireVerified = async (spaceId, container) => requireNoViolations(await verifyContainer(spaceId, container), 'container');

  const requireGatekeeperVerified = async (spaceId, container) => requireNoViolations(await verifyGatekeeperContainer(spaceId, container), 'gatekeeper');

  const remove = async (spaceId) => {
    const resources = await findResources(requireSpaceId(spaceId));
    const removed = [];
    const failed = [];
    for (const { kind, name } of resources) {
      const problem = await removeOne(kind, name);
      if (problem) {
        failed.push(problem);
      } else {
        removed.push({ kind, name });
      }
    }
    return { removed, failed };
  };

  const rollBack = async (spaceId) => {
    try {
      return (await remove(spaceId)).failed;
    } catch (error) {
      return [{ kind: 'space', name: spaceId, message: error.message }];
    }
  };

  const execInContainer = (spaceId, argv, options = {}) => run(
    ['exec', '--interactive', '--user', SPACE_USER, spaceResourceName(spaceId, execRole(options.target)), ...argv],
    options.timeoutMs ?? EXEC_TIMEOUT_MS,
    {
      stdin: options.stdin ?? '',
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.keepTail === true ? { keepTail: true } : {}),
      ...(options.killTree === true ? { killTree: true } : {}),
    },
  );

  const server = createSpaceServerChannel({ exec: execInContainer, wait, now: () => now().getTime() });
  const gatekeeper = createGatekeeperChannel({ exec: execInContainer, wait, now: () => now().getTime() });

  const create = async ({ id, name, project, created, memoryBytes }, { onStep = () => {}, startConfig = null } = {}) => {
    requireMemoryBytes(memoryBytes);
    const labelArguments = new Map([ROLE_NETWORK, ROLE_OUTER_NETWORK, ROLE_VOLUME, ROLE_SETUP, ROLE_GATEKEEPER, ROLE_SPACE].map((role) => (
      [role, labelArgs(buildSpaceLabels({ id, role, owner, project, name, created }))]
    )));
    const labelsFor = (role) => labelArguments.get(role);
    const resources = {
      spaceId: id,
      network: spaceResourceName(id, ROLE_NETWORK),
      workVolume: spaceResourceName(id, ROLE_VOLUME, 'work'),
      homeVolume: spaceResourceName(id, ROLE_VOLUME, 'home'),
      image: SPACE_BASE_IMAGE,
    };
    const outerNetwork = spaceResourceName(id, ROLE_OUTER_NETWORK);
    const containerName = spaceResourceName(id, ROLE_SPACE);
    const gatekeeperName = spaceResourceName(id, ROLE_GATEKEEPER);
    const taken = [
      ['container', containerName],
      ['container', spaceResourceName(id, ROLE_SETUP)],
      ['container', gatekeeperName],
      ['network', resources.network],
      ['network', outerNetwork],
      ['volume', resources.workVolume],
      ['volume', resources.homeVolume],
    ];

    for (const [kind, resourceName] of taken) {
      if (await inspect(kind, resourceName)) {
        throw new SpaceError('space_name_taken', `Docker already has a ${kind} named ${resourceName}. Remove it or create the space again.`);
      }
    }

    let toolsVolume = null;
    try {
      let slowStep = false;
      await ensureImage(() => { slowStep = true; onStep('downloading_image'); });
      toolsVolume = await tools.ensure({ onFill: () => { slowStep = true; onStep('preparing_tools'); } });
      if (slowStep) onStep('creating');
      await docker(buildSpaceNetworkArgs({ network: resources.network, labelArguments: labelsFor(ROLE_NETWORK) }), CHANGE_TIMEOUT_MS);
      await docker(buildGatekeeperNetworkArgs({ network: outerNetwork, labelArguments: labelsFor(ROLE_OUTER_NETWORK) }), CHANGE_TIMEOUT_MS);
      await docker(['volume', 'create', ...labelsFor(ROLE_VOLUME), resources.workVolume], CHANGE_TIMEOUT_MS);
      await docker(['volume', 'create', ...labelsFor(ROLE_VOLUME), resources.homeVolume], CHANGE_TIMEOUT_MS);
      await docker(buildVolumeOwnershipRunArgs({
        ...resources,
        containerName: spaceResourceName(id, ROLE_SETUP),
        labelArguments: labelsFor(ROLE_SETUP),
      }), CHANGE_TIMEOUT_MS);
      await docker(buildGatekeeperCreateArgs({
        containerName: gatekeeperName,
        labelArguments: labelsFor(ROLE_GATEKEEPER),
        network: resources.network,
        image: SPACE_BASE_IMAGE,
      }), CHANGE_TIMEOUT_MS);
      await docker(['network', 'connect', outerNetwork, gatekeeperName], CHANGE_TIMEOUT_MS);
      await requireGatekeeperVerified(id, await inspectOwnContainer(id, gatekeeperName) ?? {});
      await docker(['start', gatekeeperName], CHANGE_TIMEOUT_MS);
      await gatekeeper.writeProgram(id, { bindAddress: await innerAddressOf(id) });
      await gatekeeper.waitUntilReady(id);
      await docker(buildSpaceCreateArgs({
        ...resources,
        containerName,
        labelArguments: labelsFor(ROLE_SPACE),
        toolsVolume,
        memoryBytes,
        startConfig,
      }), CHANGE_TIMEOUT_MS);
      await requireVerified(id, await inspectOwnContainer(id, containerName) ?? {});
      await docker(['start', containerName], CHANGE_TIMEOUT_MS);
      await server.linkPlugin(id);
      await server.writeToken(id, createSpaceToken());
      await server.waitUntilReady(id);
    } catch (error) {
      let rollbackFailures = await rollBack(id);
      const uncertain = isInterrupted(error);
      if (uncertain) {
        await wait(ROLLBACK_SETTLE_MS);
        rollbackFailures = [...(await rollBack(id)), ...(await engine.removeByName(taken))];
      }
      if (toolsVolume) {
        rollbackFailures = [...rollbackFailures, ...(await tools.removeIfUnlabelled(toolsVolume))];
      }
      const leftovers = rollbackFailures.length > 0
        ? ` Clean-up also failed for: ${rollbackFailures.map((item) => `${item.kind} ${item.name}`).join(', ')}.`
        : '';
      const wrapped = new SpaceError(
        error.code ?? 'space_create_failed',
        `Could not create the space. ${error.message}${leftovers}${uncertain ? ' Docker may still finish the interrupted step, so look at the spaces list.' : ''}`,
        { original: error.details ?? null, rollbackFailures, uncertain },
      );
      wrapped.cause = error;
      throw wrapped;
    }
  };

  const list = async () => {
    const byId = new Map();
    for (const resource of await findResources(null)) {
      const group = byId.get(resource.labels.id) ?? [];
      group.push(resource);
      byId.set(resource.labels.id, group);
    }
    return Array.from(byId.entries(), ([id, group]) => {
      const containers = group.filter((resource) => resource.labels.role === ROLE_SPACE);
      const space = containers.find((resource) => resource.name === spaceResourceName(id, ROLE_SPACE)) ?? containers[0];
      const { name, project, created } = (space ?? group[0]).labels;
      let state = 'missing';
      if (space) {
        state = space.entry.State?.Running === true ? 'running' : 'exited';
      }
      const orphans = space ? [] : group.map((resource) => ({ kind: resource.kind, name: resource.name }));
      const expected = [
        spaceResourceName(id, ROLE_NETWORK),
        spaceResourceName(id, ROLE_OUTER_NETWORK),
        spaceResourceName(id, ROLE_VOLUME, 'work'),
        spaceResourceName(id, ROLE_VOLUME, 'home'),
      ];
      const missing = space ? expected.filter((resourceName) => !group.some((resource) => resource.name === resourceName)) : [];
      const guard = group.find((resource) => resource.labels.role === ROLE_GATEKEEPER);
      if (space && (!guard || (state === 'running' && guard.entry.State?.Running !== true))) {
        missing.push(spaceResourceName(id, ROLE_GATEKEEPER));
      }
      const stoppedIdle = state === 'exited' && space.entry.State?.ExitCode === SPACE_IDLE_EXIT_CODE;
      const gatekeeperRunning = guard?.entry.State?.Running === true;
      return { id, name, project, created, state, stoppedIdle, gatekeeperRunning, orphans, damaged: missing.length > 0, missing };
    });
  };

  const starting = new Map();

  const innerAddressOf = async (spaceId) => {
    const entry = await inspectOwnContainer(spaceId, spaceResourceName(spaceId, ROLE_GATEKEEPER));
    const address = String(entry?.NetworkSettings?.Networks?.[spaceResourceName(spaceId, ROLE_NETWORK)]?.IPAddress ?? '');
    if (net.isIP(address) === 0) {
      throw new SpaceError('gatekeeper_address_unknown', `The runtime reports no address for the network filter of space ${spaceId} on the space's network, so its listeners cannot be bound.`);
    }
    return address;
  };

  const requireGatekeeperContainer = async (spaceId) => {
    const name = spaceResourceName(spaceId, ROLE_GATEKEEPER);
    const entry = await inspectOwnContainer(spaceId, name);
    if (!entry) {
      throw new SpaceError('gatekeeper_missing', `Space ${spaceId} has no gatekeeper container. Apply or discard its work and create the space again.`);
    }
    return entry;
  };

  const exec = async (spaceId, argv, options = {}) => {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new SpaceError('invalid_command', 'A command is a non-empty array of arguments');
    }
    if (execRole(options.target) === ROLE_GATEKEEPER) {
      await requireGatekeeperContainer(spaceId);
    } else {
      await requireSpaceContainer(spaceId);
    }
    return execInContainer(spaceId, argv, options);
  };

  const execArgv = async (spaceId) => {
    const entry = await requireSpaceContainer(spaceId);
    if (entry.State?.Running !== true) {
      throw new SpaceError('space_not_running', `Space ${spaceId} is stopped. Start it, then try again.`);
    }
    return [dockerPath, ...engine.argsFor(['exec', '--interactive', '--user', SPACE_USER, spaceResourceName(spaceId, ROLE_SPACE)])];
  };

  const connect = async (spaceId) => {
    const [file, ...args] = await execArgv(spaceId);
    return openCommandStream(file, [...args, ...SPACE_CONNECT_COMMAND]);
  };

  const stop = async (spaceId) => {
    await starting.get(spaceId)?.catch(() => {});
    await requireSpaceContainer(spaceId);
    await docker(['stop', spaceResourceName(spaceId, ROLE_SPACE)], CHANGE_TIMEOUT_MS);
    const gatekeeperName = spaceResourceName(spaceId, ROLE_GATEKEEPER);
    if (await inspectOwnContainer(spaceId, gatekeeperName)) {
      await docker(['stop', gatekeeperName], CHANGE_TIMEOUT_MS);
    }
  };

  const startGatekeeper = async (spaceId) => {
    const name = spaceResourceName(spaceId, ROLE_GATEKEEPER);
    const container = await requireGatekeeperContainer(spaceId);
    if (container.State?.Running !== true) {
      await requireGatekeeperVerified(spaceId, container);
      await docker(['start', name], CHANGE_TIMEOUT_MS);
    }
    await gatekeeper.writeProgram(spaceId, { bindAddress: await innerAddressOf(spaceId) });
    await gatekeeper.waitUntilReady(spaceId);
  };

  const recreate = async (spaceId, old, toolsVolume) => {
    const name = spaceResourceName(spaceId, ROLE_SPACE);
    const aside = spaceResourceName(spaceId, ROLE_SPACE, ASIDE_SUFFIX);
    const labels = buildSpaceLabels({ ...parseSpaceLabels(old.Config?.Labels), role: ROLE_SPACE, owner });
    await docker(['rename', name, aside], CHANGE_TIMEOUT_MS);
    let createdId = '';
    try {
      createdId = (await docker(buildSpaceCreateArgs({
        spaceId,
        containerName: name,
        labelArguments: labelArgs(labels),
        network: spaceResourceName(spaceId, ROLE_NETWORK),
        workVolume: spaceResourceName(spaceId, ROLE_VOLUME, 'work'),
        homeVolume: spaceResourceName(spaceId, ROLE_VOLUME, 'home'),
        toolsVolume,
        memoryBytes: old.HostConfig?.Memory,
        image: SPACE_BASE_IMAGE,
        startConfig: startConfigOf(old),
      }), CHANGE_TIMEOUT_MS)).trim().split('\n').pop();
      await requireVerified(spaceId, await inspectOwnContainer(spaceId, createdId) ?? {});
      await docker(['start', createdId], CHANGE_TIMEOUT_MS);
      await server.waitUntilReady(spaceId);
    } catch (error) {
      const rollbackFailures = [];
      const problem = createdId ? await removeOne('container', createdId) : null;
      if (problem) rollbackFailures.push({ ...problem, name });
      try {
        await docker(['rename', aside, name], CHANGE_TIMEOUT_MS);
      } catch (renameError) {
        const current = await inspect('container', name).catch(() => null);
        if (current?.Id !== old.Id) rollbackFailures.push({ kind: 'container', name: aside, message: renameError.message });
      }
      rollbackFailures.push(...(await tools.removeIfUnlabelled(toolsVolume)));
      const outcome = rollbackFailures.length === 0
        ? 'The space keeps its old container.'
        : `Putting the old container back failed for: ${rollbackFailures.map((item) => `${item.kind} ${item.name}`).join(', ')}. Start the space again to repair it.`;
      const wrapped = new SpaceError(
        error.code ?? 'space_recreate_failed',
        `Could not move the space to the current tools. ${error.message} ${outcome}`,
        { original: error.details ?? null, rollbackFailures },
      );
      wrapped.cause = error;
      throw wrapped;
    }
    await removeOne('container', aside);
    await tools.prune();
  };

  const startOnce = async (spaceId) => {
    const name = spaceResourceName(spaceId, ROLE_SPACE);
    const aside = spaceResourceName(spaceId, ROLE_SPACE, ASIDE_SUFFIX);
    let container = await inspectOwnContainer(spaceId, name);
    const waiting = await inspectOwnContainer(spaceId, aside);
    if (!container && !waiting) {
      throw new SpaceError('space_not_found', `Space ${spaceId} has no container in Docker`);
    }
    if (container?.State?.Running === true) {
      await startGatekeeper(spaceId);
      return;
    }
    if (waiting) {
      const problem = container ? await removeStoppedContainer(container.Id) : null;
      if (problem) {
        if ((await inspectOwnContainer(spaceId, name))?.State?.Running === true) {
          await startGatekeeper(spaceId);
          return;
        }
        throw new SpaceError('space_recreate_failed', `Could not remove the unfinished container ${name}: ${problem.message}`);
      }
      await docker(['rename', aside, name], CHANGE_TIMEOUT_MS);
      container = await inspectOwnContainer(spaceId, name);
      if (!container) {
        throw new SpaceError('space_not_found', `Space ${spaceId} lost its container during the repair of a move`);
      }
    }
    await ensureImage();
    const toolsVolume = await tools.ensure();
    await startGatekeeper(spaceId);
    const mounted = (container?.Mounts ?? []).find((mount) => mount.Destination === TOOLS_MOUNT_PATH)?.Name;
    if (mounted !== toolsVolume) {
      await recreate(spaceId, container, toolsVolume);
      return;
    }
    await docker(['start', name], CHANGE_TIMEOUT_MS);
    await server.waitUntilReady(spaceId);
  };

  const start = async (spaceId) => {
    requireSpaceId(spaceId);
    if (!starting.has(spaceId)) {
      starting.set(spaceId, startOnce(spaceId).finally(() => { starting.delete(spaceId); }));
    }
    return starting.get(spaceId);
  };

  return { id, machine, check, create, list, exec, execArgv, connect, stop, start, remove, verify, readDisk: disk.read, cleanUpDisk: disk.cleanUp, pullImage, imagePulling: () => imagePull !== null };
}
