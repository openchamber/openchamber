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
import { SPACE_CONNECT_COMMAND, SPACE_USER, TOOLS_MOUNT_PATH } from '../layout.js';
import { openCommandStream as openCommandStreamProcess } from '../run-command.js';
import { createSpaceServerChannel, createSpaceToken } from '../space-server.js';
import { CHANGE_TIMEOUT_MS, ROLLBACK_SETTLE_MS, createDockerEngine, entryLabels, entryName, isInterrupted, pause } from './docker-engine.js';
import { createDockerTools } from './docker-tools.js';

const DOCKER_PLACE_ID = 'docker';

// node:22-bookworm as a multi-arch index digest. DOCUMENTATION.md says how it was verified.
export const SPACE_BASE_IMAGE = 'node@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844';

const CHECK_TIMEOUT_MS = 10_000;
const PULL_TIMEOUT_MS = 20 * 60_000;
const EXEC_TIMEOUT_MS = 60_000;
// The bridge option that keeps the space away from services on the Docker host.
const HOST_ISOLATION_MIN_ENGINE = 28;
// While a space moves to a new tools volume, its old container waits under this suffix.
const ASIDE_SUFFIX = 'old';

// Removal order. A network cannot go while a container is attached, and a volume cannot go while mounted.
const KINDS = ['container', 'volume', 'network'];

/** Which container an `exec` runs in. The place contract knows two targets and no more. */
function execRole(target) {
  if (target === undefined || target === ROLE_SPACE) {
    return ROLE_SPACE;
  }
  if (target === ROLE_GATEKEEPER) {
    return ROLE_GATEKEEPER;
  }
  throw new SpaceError('invalid_exec_target', `A command runs in the space or in its gatekeeper, not in '${target}'`);
}

export function createDockerPlace({ runCommand, openCommandStream = openCommandStreamProcess, dockerPath, owner, toolsSource, wait = pause, now = () => new Date() }) {
  requireOwner(owner);

  const engine = createDockerEngine({ runCommand, dockerPath });
  const { run, docker, inspect, removeOne, removeStoppedContainer } = engine;
  const tools = createDockerTools({ engine, owner, toolsSource, image: SPACE_BASE_IMAGE, now, wait });

  /** Every resource that carries our marker and this owner, optionally for one space. Found by label only. */
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

  /** The inspect entry of a container of this space, or null. Refuses one without this owner's labels. */
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

  /**
   * The container of the space, for the operations that only read or stop. They repair nothing.
   * While a move to new tools is under way, or after one died, the container waits under its
   * aside name. Only `start` finishes or undoes a move, so these operations say so and change nothing.
   */
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
        return unavailable('docker_daemon_unreachable', 'Docker did not answer in time. Restart Docker Desktop or Colima, then try again.');
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
      return unavailable('docker_daemon_unreachable', 'Docker is installed but not running. Start Docker Desktop or Colima, then try again.');
    }
    // Older engines call the builtin profile `default`.
    if (!securityOptions.some((option) => /^name=seccomp,profile=(builtin|default)$/.test(option))) {
      return unavailable('docker_seccomp_missing', 'This Docker engine runs containers without its builtin seccomp profile. Turn seccomp back on in the Docker daemon settings, then try again.');
    }

    return {
      available: true,
      version: server.Version,
      os: server.Os,
      arch: server.Arch,
      // False means a space on this engine could reach services that listen on the Docker host.
      hostIsolation: Number.parseInt(server.Version, 10) >= HOST_ISOLATION_MIN_ENGINE,
    };
  };

  const ensureImage = async () => {
    const present = await inspect('image', SPACE_BASE_IMAGE);
    if (present) {
      return;
    }
    const result = await run(['pull', SPACE_BASE_IMAGE], PULL_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new SpaceError(
        'image_pull_failed',
        `Could not download the base image: ${result.stderr.trim() || `exit code ${result.code}`}. Common causes: no internet access on the Docker machine, or Docker's credential helper cannot run in this session.`,
      );
    }
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

  /**
   * Both containers and both networks. A space with no gatekeeper is a space with an
   * uncontrolled way out, so it is a violation like any other and the manager removes it.
   */
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

  /**
   * Runs argv as the space user in the space or, with `target: 'gatekeeper'`, in its gatekeeper.
   * It does not look at the container first, so it also serves containers this place just made.
   */
  const execInContainer = (spaceId, argv, options = {}) => run(
    ['exec', '--interactive', '--user', SPACE_USER, spaceResourceName(spaceId, execRole(options.target)), ...argv],
    options.timeoutMs ?? EXEC_TIMEOUT_MS,
    { stdin: options.stdin ?? '' },
  );

  const server = createSpaceServerChannel({ exec: execInContainer, wait, now: () => now().getTime() });
  const gatekeeper = createGatekeeperChannel({ exec: execInContainer, wait, now: () => now().getTime() });

  const create = async ({ id, name, project, created, memoryBytes }) => {
    requireMemoryBytes(memoryBytes);
    // Built first, so a bad spec is rejected before Docker is asked anything.
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

    // `docker volume create` succeeds silently on an existing name, so look first.
    // This stays outside the rollback: nothing here is ours to remove yet.
    for (const [kind, resourceName] of taken) {
      if (await inspect(kind, resourceName)) {
        throw new SpaceError('space_name_taken', `Docker already has a ${kind} named ${resourceName}. Remove it or create the space again.`);
      }
    }

    let toolsVolume = null;
    try {
      await ensureImage();
      // The tools volume is shared by every space of this owner. It has a rollback of its own,
      // and the rollback below never touches a labelled one: it removes by space id and by the seven names only.
      toolsVolume = await tools.ensure();
      await docker(buildSpaceNetworkArgs({ network: resources.network, labelArguments: labelsFor(ROLE_NETWORK) }), CHANGE_TIMEOUT_MS);
      await docker(buildGatekeeperNetworkArgs({ network: outerNetwork, labelArguments: labelsFor(ROLE_OUTER_NETWORK) }), CHANGE_TIMEOUT_MS);
      await docker(['volume', 'create', ...labelsFor(ROLE_VOLUME), resources.workVolume], CHANGE_TIMEOUT_MS);
      await docker(['volume', 'create', ...labelsFor(ROLE_VOLUME), resources.homeVolume], CHANGE_TIMEOUT_MS);
      await docker(buildVolumeOwnershipRunArgs({
        ...resources,
        containerName: spaceResourceName(id, ROLE_SETUP),
        labelArguments: labelsFor(ROLE_SETUP),
      }), CHANGE_TIMEOUT_MS);
      // The gatekeeper comes first, and its corridor accepts connections before the space
      // container starts, so the proxy in the space environment works from the first moment.
      // It is also the first container on the inner network, which is why it holds the `.1`
      // address there: that address is the gatekeeper and never the Docker host.
      await docker(buildGatekeeperCreateArgs({
        containerName: gatekeeperName,
        labelArguments: labelsFor(ROLE_GATEKEEPER),
        network: resources.network,
        image: SPACE_BASE_IMAGE,
      }), CHANGE_TIMEOUT_MS);
      // A second network needs its own call: Docker refuses `--network-alias` with two `--network`.
      await docker(['network', 'connect', outerNetwork, gatekeeperName], CHANGE_TIMEOUT_MS);
      await requireGatekeeperVerified(id, await inspectOwnContainer(id, gatekeeperName) ?? {});
      await docker(['start', gatekeeperName], CHANGE_TIMEOUT_MS);
      await gatekeeper.writeProgram(id);
      await gatekeeper.waitUntilReady(id);
      // Create, verify, then start: a container that fails the check never runs.
      await docker(buildSpaceCreateArgs({
        ...resources,
        containerName,
        labelArguments: labelsFor(ROLE_SPACE),
        toolsVolume,
        memoryBytes,
      }), CHANGE_TIMEOUT_MS);
      await requireVerified(id, await inspectOwnContainer(id, containerName) ?? {});
      await docker(['start', containerName], CHANGE_TIMEOUT_MS);
      // The server inside waits for its token. It arrives on stdin, after the start,
      // so it is in no argument, no container env and no label.
      await server.linkPlugin(id);
      await server.writeToken(id, createSpaceToken());
      await server.waitUntilReady(id);
    } catch (error) {
      let rollbackFailures = await rollBack(id);
      // The CLI was killed, the daemon may still finish the step. Sweep again after a pause.
      const uncertain = isInterrupted(error);
      if (uncertain) {
        await wait(ROLLBACK_SETTLE_MS);
        rollbackFailures = [...(await rollBack(id)), ...(await engine.removeByName(taken))];
      }
      // Last, because a volume cannot go while the failed container still mounts it.
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
      // A move to new tools that died half way leaves two containers. The one with the plain name is the space.
      const containers = group.filter((resource) => resource.labels.role === ROLE_SPACE);
      const space = containers.find((resource) => resource.name === spaceResourceName(id, ROLE_SPACE)) ?? containers[0];
      const { name, project, created } = (space ?? group[0]).labels;
      let state = 'missing';
      if (space) {
        state = space.entry.State?.Running === true ? 'running' : 'exited';
      }
      const orphans = space ? [] : group.map((resource) => ({ kind: resource.kind, name: resource.name }));
      // A container whose network, volume or gatekeeper is gone. `list` only reports it and repairs nothing.
      const expected = [
        spaceResourceName(id, ROLE_NETWORK),
        spaceResourceName(id, ROLE_OUTER_NETWORK),
        spaceResourceName(id, ROLE_VOLUME, 'work'),
        spaceResourceName(id, ROLE_VOLUME, 'home'),
      ];
      const missing = space ? expected.filter((resourceName) => !group.some((resource) => resource.name === resourceName)) : [];
      // `state` stays the state of the space container, because that is what start and stop act on.
      // A gatekeeper that is absent, or that does not run while the space does, is as good as no
      // gatekeeper for the space, and both count as missing here.
      const guard = group.find((resource) => resource.labels.role === ROLE_GATEKEEPER);
      if (space && (!guard || (state === 'running' && guard.entry.State?.Running !== true))) {
        missing.push(spaceResourceName(id, ROLE_GATEKEEPER));
      }
      return { id, name, project, created, state, orphans, damaged: missing.length > 0, missing };
    });
  };

  // Starts that are under way in this process, by space id.
  const starting = new Map();

  /** The gatekeeper container of a space. It is never renamed, so there is no move to repair here. */
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

  /**
   * The argv that runs a command in the space with its stdin and stdout attached, for a caller that
   * must start the process itself: git starts it for a push over `ext::`. Only the space, never the
   * gatekeeper. The same ownership check as `exec` runs first, so a missing container or one this
   * installation did not create is refused, and so is a stopped one. The argv carries no secret.
   */
  const execArgv = async (spaceId) => {
    const entry = await requireSpaceContainer(spaceId);
    // A stopped container would only answer git with the daemon's own words.
    if (entry.State?.Running !== true) {
      throw new SpaceError('space_not_running', `Space ${spaceId} is stopped. Start it, then try again.`);
    }
    return [dockerPath, 'exec', '--interactive', '--user', SPACE_USER, spaceResourceName(spaceId, ROLE_SPACE)];
  };

  /**
   * A channel to the server inside the space: the bridge of `layout.js` over the argv of
   * `execArgv`, so the same ownership and running checks come first, and the same process
   * shape as a push carries the bytes. The space's network never sees it. The stream is a
   * `CommandStream` of `run-command.js`, and the dispatcher's agent uses it as a socket.
   */
  const connect = async (spaceId) => {
    const [file, ...args] = await execArgv(spaceId);
    return openCommandStream(file, [...args, ...SPACE_CONNECT_COMMAND]);
  };

  /**
   * The space stops first and its gatekeeper after it, so a space is never running while its
   * way out is not under the host's control. A stop of the gatekeeper that fails leaves the
   * space stopped, which is the safe side of this order.
   */
  const stop = async (spaceId) => {
    // A start of this space that is under way finishes first, whatever its outcome. A stop that
    // slipped in between the create and the start of a move would resolve, and the space would run anyway.
    await starting.get(spaceId)?.catch(() => {});
    await requireSpaceContainer(spaceId);
    await docker(['stop', spaceResourceName(spaceId, ROLE_SPACE)], CHANGE_TIMEOUT_MS);
    const gatekeeperName = spaceResourceName(spaceId, ROLE_GATEKEEPER);
    if (await inspectOwnContainer(spaceId, gatekeeperName)) {
      await docker(['stop', gatekeeperName], CHANGE_TIMEOUT_MS);
    }
  };

  /**
   * The gatekeeper runs, with its program, before the space container starts. Its tmpfs is empty
   * again after every stop, so the program is written at every start. The network mode, the
   * allowlist and the grants are not restored here: the gatekeeper comes up allowing nothing,
   * and the host says again what this space may reach. No container of ours restarts by itself,
   * so this also holds after the Docker machine restarts.
   */
  const startGatekeeper = async (spaceId) => {
    const name = spaceResourceName(spaceId, ROLE_GATEKEEPER);
    const container = await requireGatekeeperContainer(spaceId);
    if (container.State?.Running !== true) {
      await requireGatekeeperVerified(spaceId, container);
      await docker(['start', name], CHANGE_TIMEOUT_MS);
    }
    await gatekeeper.writeProgram(spaceId);
    await gatekeeper.waitUntilReady(spaceId);
  };

  /**
   * Moves a stopped space to the current tools volume. The mounts of a container are fixed
   * at creation, so the container is made again. Everything the space owns lives in its
   * two volumes, so nothing is lost. The old container waits aside until the new one is healthy.
   *
   * The new container is only ever removed by the id that `docker create` printed. A name
   * says nothing here: if anything gave the old container its name back in the meantime, a
   * removal by name would delete the space's only container.
   */
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
      }), CHANGE_TIMEOUT_MS)).trim().split('\n').pop();
      await requireVerified(spaceId, await inspectOwnContainer(spaceId, createdId) ?? {});
      await docker(['start', createdId], CHANGE_TIMEOUT_MS);
      await server.waitUntilReady(spaceId);
    } catch (error) {
      // Back to the old container. It still has the old tools, and it still works.
      // When the create itself failed there is no id, and nothing is removed.
      const rollbackFailures = [];
      const problem = createdId ? await removeOne('container', createdId) : null;
      if (problem) rollbackFailures.push({ ...problem, name });
      try {
        await docker(['rename', aside, name], CHANGE_TIMEOUT_MS);
      } catch (renameError) {
        // Fine when the old container already has its name back.
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
    // A leftover here loses nothing. `remove` removes it. The next start of the stopped space takes the
    // container with the plain name for unfinished, goes back to this old one, and moves the space again.
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
      // The space runs, so its own container and its tools are left alone. Its way out is not
      // the space's container: a gatekeeper that died, from its own memory limit or anything
      // else, is brought back here. Otherwise the one action a user would take, "start", would
      // skip the only step that repairs it.
      await startGatekeeper(spaceId);
      return;
    }
    if (waiting) {
      // A move that died half way. A stopped container with the plain name is the unfinished new one.
      // It goes by the id that was just inspected, and without force: if another process started it
      // in the meantime, Docker refuses, and a running container is a space that is already started.
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
    // Before either way of starting the space. The move to new tools leaves the gatekeeper
    // alone: it mounts no tools volume, so a new tools version changes nothing about it.
    await startGatekeeper(spaceId);
    const mounted = (container?.Mounts ?? []).find((mount) => mount.Destination === TOOLS_MOUNT_PATH)?.Name;
    if (mounted !== toolsVolume) {
      await recreate(spaceId, container, toolsVolume);
      return;
    }
    await docker(['start', name], CHANGE_TIMEOUT_MS);
    // The token is already in HOME, so the server comes up by itself.
    await server.waitUntilReady(spaceId);
  };

  /**
   * A running space is never touched. A stopped one picks up the current tools here, and a
   * half-done move is repaired here and nowhere else. Calls for one space share one run in this
   * process, so two starts never move the same container at once.
   */
  const start = async (spaceId) => {
    requireSpaceId(spaceId);
    if (!starting.has(spaceId)) {
      starting.set(spaceId, startOnce(spaceId).finally(() => { starting.delete(spaceId); }));
    }
    return starting.get(spaceId);
  };

  return { id: DOCKER_PLACE_ID, check, create, list, exec, execArgv, connect, stop, start, remove, verify };
}
