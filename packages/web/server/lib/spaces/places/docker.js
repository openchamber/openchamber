import { SpaceError } from '../errors.js';
import {
  SPACE_USER,
  buildSpaceCreateArgs,
  buildSpaceNetworkArgs,
  buildVolumeOwnershipRunArgs,
  findHardeningViolations,
  requireMemoryBytes,
} from '../hardening.js';
import {
  ROLE_NETWORK,
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

const DOCKER_PLACE_ID = 'docker';

// node:22-bookworm as a multi-arch index digest. DOCUMENTATION.md says how it was verified.
export const SPACE_BASE_IMAGE = 'node@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844';

// Stage 1b replaces this with the server inside the space.
const IDLE_COMMAND = ['tail', '-f', '/dev/null'];

const CHECK_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;
const CHANGE_TIMEOUT_MS = 120_000;
const PULL_TIMEOUT_MS = 20 * 60_000;
const EXEC_TIMEOUT_MS = 60_000;
// After a timed-out step the daemon may still finish it. The rollback sweeps again after this pause.
const ROLLBACK_SETTLE_MS = 2_000;
// The bridge option that keeps the space away from services on the Docker host.
const HOST_ISOLATION_MIN_ENGINE = 28;

// Removal order. A network cannot go while a container is attached, and a volume cannot go while mounted.
const KINDS = ['container', 'volume', 'network'];

const NOT_FOUND_PATTERNS = [
  /\bNo such (?:object|container|volume|network|image)\b/i,
  /\b(?:container|volume|network)\b.*\bnot found\b/i,
];

// The CLI died in the middle of a step, so nobody knows whether the daemon finished it.
const INTERRUPTED_CODES = ['command_timeout', 'command_killed', 'command_output_too_large'];

const isNotFound = (result) => result.code !== 0 && NOT_FOUND_PATTERNS.some((pattern) => pattern.test(result.stderr));

// For a removal, "someone else is removing it right now" is as good as gone.
const REMOVAL_IN_PROGRESS = /removal of container .* is already in progress/i;
const isAlreadyGone = (result) => isNotFound(result) || (result.code !== 0 && REMOVAL_IN_PROGRESS.test(result.stderr));

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new SpaceError('docker_output_unreadable', 'Docker printed something that is not JSON');
  }
};

const inspectArgs = (kind, names) => (kind === 'container' ? ['inspect', '--type', 'container', ...names] : [kind, 'inspect', ...names]);
const listArgs = (kind, filters) => (kind === 'container'
  ? ['ps', '--all', ...filters, '--format', '{{.Names}}']
  : [kind, 'ls', ...filters, '--format', '{{.Name}}']);
const removeArgs = (kind, name) => (kind === 'container' ? ['rm', '--force', name] : [kind, 'rm', name]);

const entryLabels = (kind, entry) => (kind === 'container' ? entry.Config?.Labels : entry.Labels);
const entryName = (entry) => String(entry.Name ?? '').replace(/^\//, '');

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

export function createDockerPlace({ runCommand, dockerPath, owner, wait = pause }) {
  requireOwner(owner);

  const run = (args, timeoutMs) => runCommand(dockerPath, args, { timeoutMs });

  const failure = (args, result) => new SpaceError(
    'docker_command_failed',
    `docker ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim() || `exit code ${result.code}`}`,
  );

  const docker = async (args, timeoutMs) => {
    const result = await run(args, timeoutMs);
    if (result.code !== 0) {
      throw failure(args, result);
    }
    return result.stdout;
  };

  /** The parsed inspect entry, or null when Docker has no such resource. */
  const inspect = async (kind, name) => {
    const args = inspectArgs(kind, [name]);
    const result = await run(args, QUERY_TIMEOUT_MS);
    if (isNotFound(result)) {
      return null;
    }
    if (result.code !== 0) {
      throw failure(args, result);
    }
    return parseJson(result.stdout)[0];
  };

  /** Every resource that carries our marker and this owner, optionally for one space. Found by label only. */
  const findResources = async (spaceId) => {
    const filters = labelFilterArgs({ owner, spaceId });
    const resources = [];
    for (const kind of KINDS) {
      const names = (await docker(listArgs(kind, filters), QUERY_TIMEOUT_MS)).split('\n').filter(Boolean);
      if (names.length === 0) {
        continue;
      }
      // A name can vanish between the listing and the inspect. Docker then exits 1 but
      // still prints the entries it found, and the rest of the spaces must not suffer.
      const args = inspectArgs(kind, names);
      const result = await run(args, QUERY_TIMEOUT_MS);
      if (result.code !== 0 && !isNotFound(result)) {
        throw failure(args, result);
      }
      for (const entry of parseJson(result.stdout)) {
        const labels = parseSpaceLabels(entryLabels(kind, entry));
        if (labels && labels.owner === owner && (spaceId === null || labels.id === spaceId)) {
          resources.push({ kind, name: entryName(entry), labels, entry });
        }
      }
    }
    return resources;
  };

  const requireSpaceContainer = async (spaceId) => {
    const name = spaceResourceName(spaceId, ROLE_SPACE);
    const entry = await inspect('container', name);
    if (!entry) {
      throw new SpaceError('space_not_found', `Space ${spaceId} has no container in Docker`);
    }
    const labels = parseSpaceLabels(entry.Config?.Labels);
    if (labels?.id !== spaceId || labels?.owner !== owner) {
      throw new SpaceError('space_not_ours', `Container ${name} exists but this OpenChamber installation did not create it`);
    }
    return entry;
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

  const verify = async (spaceId) => {
    const container = await requireSpaceContainer(spaceId);
    const network = await inspect('network', spaceResourceName(spaceId, ROLE_NETWORK));
    return findHardeningViolations({ spaceId, owner, container, network });
  };

  /** Null when the resource is gone afterwards, otherwise what went wrong. */
  const removeOne = async (kind, name) => {
    try {
      const result = await run(removeArgs(kind, name), CHANGE_TIMEOUT_MS);
      return result.code === 0 || isAlreadyGone(result) ? null : { kind, name, message: result.stderr.trim() };
    } catch (error) {
      return { kind, name, message: error.message };
    }
  };

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
   * Removes the named resources that exist, labelled or not. Only for names that the
   * same create call found absent a moment ago: a `docker create` or `docker run` that
   * the daemon finishes late makes a missing `src=` volume again, without labels.
   */
  const removeByName = async (names) => {
    const failed = [];
    for (const [kind, name] of names) {
      try {
        if (await inspect(kind, name)) {
          const problem = await removeOne(kind, name);
          if (problem) failed.push(problem);
        }
      } catch (error) {
        failed.push({ kind, name, message: error.message });
      }
    }
    return failed;
  };

  const create = async ({ id, name, project, created, memoryBytes }) => {
    requireMemoryBytes(memoryBytes);
    // Built first, so a bad spec is rejected before Docker is asked anything.
    const labelArguments = new Map([ROLE_NETWORK, ROLE_VOLUME, ROLE_SETUP, ROLE_SPACE].map((role) => (
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
    const containerName = spaceResourceName(id, ROLE_SPACE);
    const taken = [
      ['container', containerName],
      ['container', spaceResourceName(id, ROLE_SETUP)],
      ['network', resources.network],
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

    try {
      await ensureImage();
      await docker(buildSpaceNetworkArgs({ network: resources.network, labelArguments: labelsFor(ROLE_NETWORK) }), CHANGE_TIMEOUT_MS);
      await docker(['volume', 'create', ...labelsFor(ROLE_VOLUME), resources.workVolume], CHANGE_TIMEOUT_MS);
      await docker(['volume', 'create', ...labelsFor(ROLE_VOLUME), resources.homeVolume], CHANGE_TIMEOUT_MS);
      await docker(buildVolumeOwnershipRunArgs({
        ...resources,
        containerName: spaceResourceName(id, ROLE_SETUP),
        labelArguments: labelsFor(ROLE_SETUP),
      }), CHANGE_TIMEOUT_MS);
      // Create, verify, then start: a container that fails the check never runs.
      await docker(buildSpaceCreateArgs({
        ...resources,
        containerName,
        labelArguments: labelsFor(ROLE_SPACE),
        memoryBytes,
        command: IDLE_COMMAND,
      }), CHANGE_TIMEOUT_MS);
      const violations = await verify(id);
      if (violations.length > 0) {
        throw new SpaceError(
          'space_verification_failed',
          `The new container does not match the requested restrictions: ${violations.map((violation) => violation.message).join('; ')}`,
          { violations },
        );
      }
      await docker(['start', containerName], CHANGE_TIMEOUT_MS);
    } catch (error) {
      let rollbackFailures = await rollBack(id);
      // The CLI was killed, the daemon may still finish the step. Sweep again after a pause.
      const uncertain = INTERRUPTED_CODES.includes(error.code);
      if (uncertain) {
        await wait(ROLLBACK_SETTLE_MS);
        rollbackFailures = [...(await rollBack(id)), ...(await removeByName(taken))];
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
      const space = group.find((resource) => resource.labels.role === ROLE_SPACE);
      const { name, project, created } = (space ?? group[0]).labels;
      let state = 'missing';
      if (space) {
        state = space.entry.State?.Running === true ? 'running' : 'exited';
      }
      const orphans = space ? [] : group.map((resource) => ({ kind: resource.kind, name: resource.name }));
      // A container whose network or volume is gone. `list` only reports it and repairs nothing.
      const expected = [spaceResourceName(id, ROLE_NETWORK), spaceResourceName(id, ROLE_VOLUME, 'work'), spaceResourceName(id, ROLE_VOLUME, 'home')];
      const missing = space ? expected.filter((resourceName) => !group.some((resource) => resource.name === resourceName)) : [];
      return { id, name, project, created, state, orphans, damaged: missing.length > 0, missing };
    });
  };

  const exec = async (spaceId, argv, options = {}) => {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new SpaceError('invalid_command', 'A command is a non-empty array of arguments');
    }
    await requireSpaceContainer(spaceId);
    return runCommand(
      dockerPath,
      ['exec', '--interactive', '--user', SPACE_USER, spaceResourceName(spaceId, ROLE_SPACE), ...argv],
      { stdin: options.stdin ?? '', timeoutMs: options.timeoutMs ?? EXEC_TIMEOUT_MS },
    );
  };

  const stop = async (spaceId) => {
    await requireSpaceContainer(spaceId);
    await docker(['stop', spaceResourceName(spaceId, ROLE_SPACE)], CHANGE_TIMEOUT_MS);
  };

  const start = async (spaceId) => {
    await requireSpaceContainer(spaceId);
    await docker(['start', spaceResourceName(spaceId, ROLE_SPACE)], CHANGE_TIMEOUT_MS);
  };

  return { id: DOCKER_PLACE_ID, check, create, list, exec, stop, start, remove, verify };
}
