import { SpaceError } from './errors.js';
import {
  ROLE_NETWORK,
  ROLE_OUTER_NETWORK,
  ROLE_TOOLS,
  parseSpaceLabels,
  parseToolsLabels,
  spaceResourceName,
  spaceResourcePrefix,
  toolsKeyFromVolumeName,
} from './labels.js';
import {
  GATEKEEPER_ALIAS,
  GATEKEEPER_COMMAND,
  GATEKEEPER_ENVIRONMENT,
  IMAGE_CAT,
  IMAGE_CHOWN,
  IMAGE_NODE,
  IMAGE_SH,
  SPACE_ENVIRONMENT,
  SPACE_HOME,
  SPACE_SERVER_COMMAND,
  SPACE_USER,
  TOOLS_MARKER_PATH,
  TOOLS_MOUNT_PATH,
  spaceWorkPath,
} from './layout.js';
import { FILLER_PROGRAM } from './tools-filler.js';
import { TOOLS_STAGING_PATH } from './tools.js';

const SPACE_PIDS_LIMIT = 512;
const SPACE_SHM_BYTES = 64 * 1024 * 1024;
const TMPFS_OPTIONS = 'rw,exec,nosuid,size=256m';
// The gatekeeper's tmpfs holds one file, its own program, and nothing runs from it: Node reads
// the file. So it is small and without `exec`, where a space needs both.
const GATEKEEPER_TMPFS_OPTIONS = 'rw,noexec,nosuid,size=16m';
// Measured: an idle gatekeeper with its listeners holds about 24 MiB. This is ten times that.
// The tunnel cap is 64, and two sockets with their buffers cost well under a megabyte each, so
// a gatekeeper at its busiest stays far below the limit and an unexpected leak is still capped.
const GATEKEEPER_MEMORY_BYTES = 256 * 1024 * 1024;
const MIN_MEMORY_BYTES = 64 * 1024 * 1024;
const SETUP_MEMORY_BYTES = 128 * 1024 * 1024;
// The filler keeps the npm cache and the tarballs in its tmpfs, and a tmpfs counts as memory.
// Measured: the cache of one fill is 444 MB.
const FILLER_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const FILLER_TMPFS_OPTIONS = 'rw,exec,nosuid,size=1g';
// The container environment is an allowlist. Anything in it is readable through `docker inspect`
// and by every process inside, and OpenCode 2 turns some variables into a login: a provider key
// under one of its catalog's names, or a key inside OPENCODE_CONFIG_CONTENT. So a container may
// carry the variables we set and the base image's own, and nothing else. The server password is
// named on its own as well, so its message stays specific.
const FORBIDDEN_ENVIRONMENT = ['OPENCHAMBER_UI_PASSWORD'];
// The variables the pinned base image sets itself. Docker copies them into every container made
// from it. Read on 2026-09-24 with
// `docker image inspect <SPACE_BASE_IMAGE> --format '{{json .Config.Env}}'`, which answered
// PATH, NODE_VERSION=22.23.2 and YARN_VERSION=1.22.22. Read them again when the digest changes.
const BASE_IMAGE_ENVIRONMENT_NAMES = ['PATH', 'NODE_VERSION', 'YARN_VERSION'];
const SPACE_ENVIRONMENT_NAMES = new Set([...Object.keys(SPACE_ENVIRONMENT), ...BASE_IMAGE_ENVIRONMENT_NAMES]);
const GATEKEEPER_ENVIRONMENT_NAMES = new Set([...Object.keys(GATEKEEPER_ENVIRONMENT), ...BASE_IMAGE_ENVIRONMENT_NAMES]);

// Container output lands in a file on the Docker host. One 10 MB file, no rotation copies.
// The `local` driver refuses max-file=1 unless compression is off.
const LOG_DRIVER = 'local';
const LOG_MAX_SIZE = '10m';
const LOG_MAX_FILE = '1';
const LOG_ARGS = ['--log-driver', LOG_DRIVER, '--log-opt', `max-size=${LOG_MAX_SIZE}`, '--log-opt', `max-file=${LOG_MAX_FILE}`, '--log-opt', 'compress=false'];

// With this option the bridge gets no address on the Docker host, so the space
// cannot reach services that listen on the host. Docker Engine 28 and newer.
const GATEWAY_MODE_OPTION = 'com.docker.network.bridge.gateway_mode_ipv4';
const GATEWAY_MODE = 'isolated';

const NO_NEW_PRIVILEGES = ['no-new-privileges', 'no-new-privileges:true'];
// What a correct container reports: '' for pid, uts and userns, 'private' for ipc and cgroupns.
const PRIVATE_NAMESPACE_MODES = ['', 'private'];
const NAMESPACE_FIELDS = ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode'];

const volumeMount = (volume, destination) => ['--mount', `type=volume,src=${volume},dst=${destination}`];
const readOnlyVolumeMount = (volume, destination) => ['--mount', `type=volume,src=${volume},dst=${destination},readonly`];

// Equal values mean swap adds nothing on top of the limit.
const memoryArgs = (bytes) => ['--memory', String(bytes), '--memory-swap', String(bytes)];

export function requireMemoryBytes(value) {
  if (!Number.isSafeInteger(value) || value < MIN_MEMORY_BYTES) {
    throw new SpaceError('invalid_memory_limit', `A space needs a memory limit of at least ${MIN_MEMORY_BYTES} bytes`);
  }
  return value;
}

/** The `docker network create` argv for the inner network of a space. Only the gatekeeper joins it too. */
export function buildSpaceNetworkArgs({ network, labelArguments }) {
  return [
    'network', 'create',
    '--driver', 'bridge',
    '--internal',
    '--ipv6=false',
    '--opt', `${GATEWAY_MODE_OPTION}=${GATEWAY_MODE}`,
    ...labelArguments,
    network,
  ];
}

/**
 * The `docker network create` argv for the outer network of a space. An ordinary bridge: this is
 * the gatekeeper's way out, and the space is never attached to it. One per space, so two spaces
 * never share a network and a gatekeeper never sees another space's traffic.
 */
export function buildGatekeeperNetworkArgs({ network, labelArguments }) {
  return [
    'network', 'create',
    '--driver', 'bridge',
    '--ipv6=false',
    ...labelArguments,
    network,
  ];
}

/**
 * The full `docker create` argv for a gatekeeper container. It is hardened like a space, with
 * three differences, each of them checked in findGatekeeperHardeningViolations: no mount at all,
 * a memory limit of its own, and a tmpfs that holds only its program.
 *
 * It is created on the inner network under a fixed alias. The place attaches the outer network
 * afterwards, because Docker refuses `--network-alias` together with a second `--network`.
 */
export function buildGatekeeperCreateArgs({ containerName, labelArguments, network, image }) {
  return [
    'create',
    '--name', containerName,
    ...labelArguments,
    '--init',
    '--user', SPACE_USER,
    '--read-only',
    '--tmpfs', `/tmp:${GATEKEEPER_TMPFS_OPTIONS}`,
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--pids-limit', String(SPACE_PIDS_LIMIT),
    ...memoryArgs(GATEKEEPER_MEMORY_BYTES),
    '--shm-size', '64m',
    '--ipc', 'private',
    '--cgroupns', 'private',
    ...LOG_ARGS,
    '--network', network,
    '--network-alias', GATEKEEPER_ALIAS,
    ...Object.entries(GATEKEEPER_ENVIRONMENT).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    image,
    ...GATEKEEPER_COMMAND,
  ];
}

/**
 * The full `docker create` argv for a space container. Every restriction here has
 * a matching check in findHardeningViolations.
 */
export function buildSpaceCreateArgs({ spaceId, containerName, labelArguments, network, workVolume, homeVolume, toolsVolume, memoryBytes, image }) {
  return [
    'create',
    '--name', containerName,
    ...labelArguments,
    '--init',
    '--user', SPACE_USER,
    '--read-only',
    '--tmpfs', `/tmp:${TMPFS_OPTIONS}`,
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--pids-limit', String(SPACE_PIDS_LIMIT),
    ...memoryArgs(requireMemoryBytes(memoryBytes)),
    '--shm-size', '64m',
    // Asked for by name, so a daemon whose default is `host` or `shareable` still passes the checker.
    '--ipc', 'private',
    '--cgroupns', 'private',
    ...LOG_ARGS,
    '--network', network,
    ...volumeMount(workVolume, spaceWorkPath(spaceId)),
    ...volumeMount(homeVolume, SPACE_HOME),
    ...readOnlyVolumeMount(toolsVolume, TOOLS_MOUNT_PATH),
    ...Object.entries(SPACE_ENVIRONMENT).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    image,
    ...SPACE_SERVER_COMMAND,
  ];
}

/**
 * The argv for the one-shot root container that hands the two fresh volumes to
 * the space user. It has no network and one capability, and runs a fixed command.
 */
export function buildVolumeOwnershipRunArgs({ spaceId, containerName, labelArguments, workVolume, homeVolume, image }) {
  return [
    'run', '--rm',
    '--name', containerName,
    ...labelArguments,
    '--user', '0:0',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--cap-add', 'CHOWN',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--ipc', 'private',
    '--cgroupns', 'private',
    ...memoryArgs(SETUP_MEMORY_BYTES),
    ...LOG_ARGS,
    ...volumeMount(workVolume, spaceWorkPath(spaceId)),
    ...volumeMount(homeVolume, SPACE_HOME),
    image,
    IMAGE_CHOWN, SPACE_USER, spaceWorkPath(spaceId), SPACE_HOME,
  ];
}

/**
 * The argv for the one-shot container that fills a fresh tools volume. It is the one container
 * here with a way out: the default bridge, to reach the npm registry. Otherwise it is
 * hardened like a space. It runs as root with every capability dropped: root owns the
 * fresh volume, so npm needs none, and what it writes is readable by the space user.
 * The program is fixed, and its input arrives on stdin.
 */
export function buildToolsFillRunArgs({ containerName, labelArguments, toolsVolume, image }) {
  return [
    'run', '--rm', '--interactive',
    '--name', containerName,
    ...labelArguments,
    '--init',
    '--user', '0:0',
    '--network', 'bridge',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', `/tmp:${FILLER_TMPFS_OPTIONS}`,
    '--pids-limit', String(SPACE_PIDS_LIMIT),
    '--ipc', 'private',
    '--cgroupns', 'private',
    ...memoryArgs(FILLER_MEMORY_BYTES),
    ...LOG_ARGS,
    ...volumeMount(toolsVolume, TOOLS_MOUNT_PATH),
    // npm keeps its logs under HOME, and the root filesystem is read-only.
    '--env', 'HOME=/tmp',
    image,
    IMAGE_NODE, '-e', FILLER_PROGRAM, TOOLS_MOUNT_PATH, TOOLS_STAGING_PATH,
  ];
}

// Exit code of the marker check for "there is no marker". It is a code of its own, because
// the docker CLI exits with 1 when it cannot reach the daemon, and `cat` exits with 1 for a missing file.
// Mixing the two up would remove a filled volume.
export const TOOLS_MARKER_MISSING_EXIT_CODE = 42;
const MARKER_CHECK_SCRIPT = `[ -f "$1" ] || exit ${TOOLS_MARKER_MISSING_EXIT_CODE}; ${IMAGE_CAT} "$1"`;

/**
 * The argv for the one-shot container that prints the fill marker of a tools volume.
 * It runs as the space user, so a marker it can read is a volume a space can read.
 */
export function buildToolsCheckRunArgs({ containerName, labelArguments, toolsVolume, image }) {
  return [
    'run', '--rm',
    '--name', containerName,
    ...labelArguments,
    '--user', SPACE_USER,
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--ipc', 'private',
    '--cgroupns', 'private',
    ...memoryArgs(SETUP_MEMORY_BYTES),
    ...LOG_ARGS,
    ...readOnlyVolumeMount(toolsVolume, TOOLS_MOUNT_PATH),
    image,
    IMAGE_SH, '-c', MARKER_CHECK_SCRIPT, 'sh', TOOLS_MARKER_PATH,
  ];
}

const mentionsRuntimeSocket = (text) => String(text ?? '').includes('docker.sock');

/**
 * The checks a space and a gatekeeper share, in the order they are reported. What differs is
 * the tmpfs, the network the container must run on, and which mounts it may have, which
 * `mountViolations(mounts)` answers.
 */
function findCommonViolations({ container, tmpfsOptions, networkMode, mountViolations, allowedEnvironment }) {
  const violations = [];
  const violate = (check, message) => violations.push({ check, message });

  const config = container?.Config ?? {};
  const host = container?.HostConfig ?? {};
  const mounts = container?.Mounts ?? [];

  const variableNames = (config.Env ?? []).map((entry) => String(entry).split('=')[0]);
  const secretVariables = variableNames.filter((name) => FORBIDDEN_ENVIRONMENT.includes(name));
  if (secretVariables.length > 0) violate('environment', `The container environment holds a secret: ${secretVariables.join(', ')}`);
  const unexpectedVariables = variableNames.filter((name) => !FORBIDDEN_ENVIRONMENT.includes(name) && !allowedEnvironment.has(name));
  if (unexpectedVariables.length > 0) violate('environment', `The container environment holds variables nobody set for it: ${unexpectedVariables.join(', ')}`);
  if (config.User !== SPACE_USER) violate('user', `Runs as '${config.User ?? ''}', expected ${SPACE_USER}`);
  if (host.ReadonlyRootfs !== true) violate('read_only', 'The root filesystem is writable');
  if (host.Privileged !== false) violate('privileged', 'The container is privileged');
  if (!(host.CapDrop ?? []).includes('ALL')) violate('cap_drop', 'Capabilities are not all dropped');
  if ((host.CapAdd ?? []).length > 0) violate('cap_add', `Capabilities were added: ${host.CapAdd.join(', ')}`);

  const securityOptions = host.SecurityOpt ?? [];
  if (!securityOptions.some((option) => NO_NEW_PRIVILEGES.includes(option))) {
    violate('no_new_privileges', 'Privilege escalation is not blocked');
  }
  const extraSecurityOptions = securityOptions.filter((option) => !NO_NEW_PRIVILEGES.includes(option));
  if (extraSecurityOptions.length > 0) violate('security_options', `Unexpected security options: ${extraSecurityOptions.join(', ')}`);

  if (host.Init !== true) violate('init', 'There is no init process');
  if (!(host.PidsLimit > 0)) violate('pids_limit', 'There is no process limit');
  if (!(host.Memory > 0)) violate('memory', 'There is no memory limit');
  if (host.MemorySwap !== host.Memory) violate('memory_swap', 'Swap is allowed on top of the memory limit');
  if (host.ShmSize !== SPACE_SHM_BYTES) violate('shm_size', `Shared memory is ${host.ShmSize ?? 'unset'} bytes, expected ${SPACE_SHM_BYTES}`);

  const log = host.LogConfig ?? {};
  if (log.Type !== LOG_DRIVER || log.Config?.['max-size'] !== LOG_MAX_SIZE || log.Config?.['max-file'] !== LOG_MAX_FILE) {
    violate('log_limit', 'Container output is not capped on the Docker host');
  }

  const tmpfs = host.Tmpfs ?? {};
  const tmpOptions = String(tmpfs['/tmp'] ?? '').split(',');
  if (Object.keys(tmpfs).length !== 1 || !tmpfsOptions.split(',').every((option) => tmpOptions.includes(option))) {
    violate('tmpfs', 'The only tmpfs must be /tmp with nosuid and a size limit');
  }

  if ((host.Binds ?? []).length > 0) violate('binds', `Host paths are mounted: ${host.Binds.join(', ')}`);
  if ((host.VolumesFrom ?? []).length > 0) violate('volumes_from', 'Volumes of another container are attached');
  violations.push(...mountViolations(mounts));
  const socketMounted = mounts.some((mount) => mentionsRuntimeSocket(mount.Source) || mentionsRuntimeSocket(mount.Destination))
    || (host.Binds ?? []).some(mentionsRuntimeSocket);
  if (socketMounted) violate('runtime_socket', 'The container runtime socket is mounted');

  for (const field of NAMESPACE_FIELDS) {
    if (!PRIVATE_NAMESPACE_MODES.includes(host[field] ?? '')) violate('namespace', `${field} is '${host[field]}', which is not private`);
  }
  if (host.NetworkMode !== networkMode) violate('network_mode', `NetworkMode is '${host.NetworkMode ?? ''}', expected the network of this space`);
  if (Object.keys(host.Sysctls ?? {}).length > 0) violate('sysctls', 'Kernel parameters were changed');
  if (!['', 'runc'].includes(host.Runtime ?? '')) violate('runtime', `Unexpected container runtime '${host.Runtime}'`);
  if ((host.Devices ?? []).length > 0) violate('devices', 'Host devices are attached');
  if (Object.keys(host.PortBindings ?? {}).length > 0) violate('port_bindings', 'Ports are published on the host');

  return violations;
}

/**
 * Which mounts a space may have. The one exception to "only volumes of this space" is the mount
 * at the tools path, and it has rules of its own. A tools volume mounted anywhere else gets no exception.
 */
function findSpaceMountViolations({ mounts, prefix, owner, toolsVolume }) {
  const violations = [];
  const violate = (check, message) => violations.push({ check, message });

  for (const mount of mounts.filter((candidate) => candidate.Destination !== TOOLS_MOUNT_PATH)) {
    if (mount.Type !== 'volume' || !String(mount.Name ?? '').startsWith(prefix)) {
      violate('mounts', `Mount at ${mount.Destination} is not a volume of this space`);
    }
  }
  const toolsMounts = mounts.filter((candidate) => candidate.Destination === TOOLS_MOUNT_PATH);
  if (toolsMounts.length !== 1) {
    violate('tools_mount', `Expected one tools volume at ${TOOLS_MOUNT_PATH}, found ${toolsMounts.length}`);
    return violations;
  }
  const [mount] = toolsMounts;
  const key = toolsKeyFromVolumeName(mount.Name, owner);
  if (mount.Type !== 'volume' || key === null) {
    violate('tools_mount', `Mount at ${TOOLS_MOUNT_PATH} is not a tools volume of this installation`);
  }
  // The agent must never change the programs that the next space will run.
  if (mount.RW !== false) violate('tools_read_only', 'The tools volume is writable from inside the space');
  const toolsLabels = parseToolsLabels(toolsVolume?.Labels);
  if (toolsVolume?.Name !== mount.Name || toolsLabels?.role !== ROLE_TOOLS || toolsLabels?.owner !== owner || toolsLabels?.key !== key) {
    violate('tools_labels', 'The tools volume does not carry the tools labels of this installation');
  }
  return violations;
}

/**
 * Compares the parsed `docker inspect` entry of a space container and of its
 * network with the requested hardening. Returns one `{ check, message }` per
 * difference. An empty list means the space is verified.
 *
 * `toolsVolume` is the inspect entry of the volume mounted at the tools path, or null.
 *
 * Docker fills every field read here at `docker create`, so this runs before the
 * container starts.
 */
export function findHardeningViolations({ spaceId, owner, container, network, toolsVolume }) {
  const prefix = spaceResourcePrefix(spaceId);
  const networkName = spaceResourceName(spaceId, ROLE_NETWORK);
  const violations = findCommonViolations({
    container,
    tmpfsOptions: TMPFS_OPTIONS,
    networkMode: networkName,
    mountViolations: (mounts) => findSpaceMountViolations({ mounts, prefix, owner, toolsVolume }),
    allowedEnvironment: SPACE_ENVIRONMENT_NAMES,
  });
  const violate = (check, message) => violations.push({ check, message });

  // The space stays on one network, its inner one. The gatekeeper is the other member of it.
  const attached = Object.keys(container?.NetworkSettings?.Networks ?? {});
  if (attached.length !== 1 || attached[0] !== networkName) {
    violate('networks', `Attached to [${attached.join(', ')}], expected only the network of this space`);
  }
  violations.push(...findInnerNetworkViolations({ spaceId, owner, network }));
  return violations;
}

/** The demands on the inner network of a space: no way out, and no address on the Docker host. */
function findInnerNetworkViolations({ spaceId, owner, network }) {
  const violations = [];
  const violate = (check, message) => violations.push({ check, message });

  if (network?.Internal !== true) violate('network_internal', 'The network of this space can reach outside');
  if (network?.EnableIPv6 === true) violate('network_ipv6', 'The network of this space has IPv6');
  // An engine that ignores the option still gives the bridge a gateway address, so look at the effect too.
  const hasGateway = (network?.IPAM?.Config ?? []).some((range) => Boolean(range.Gateway));
  if (network?.Options?.[GATEWAY_MODE_OPTION] !== GATEWAY_MODE || hasGateway) {
    violate('network_host_isolation', 'The network of this space has an address on the Docker host. Docker Engine 28 or newer is needed.');
  }
  const networkLabels = parseSpaceLabels(network?.Labels);
  if (networkLabels?.id !== spaceId || networkLabels?.owner !== owner || networkLabels?.role !== ROLE_NETWORK) {
    violate('network_labels', 'The network does not carry the labels of this space');
  }
  return violations;
}

const aliasesOf = (entry) => [...(entry?.Aliases ?? []), ...(entry?.DNSNames ?? [])];

/**
 * The same comparison for the gatekeeper of a space. Every check name starts with `gatekeeper_`,
 * so a caller that verifies both containers can tell them apart.
 *
 * It is hardened like a space, with three deliberate differences:
 * - two networks, this space's inner one and this space's outer one, and no others;
 * - no mount at all, so its only writable place is the tmpfs that vanishes with the container;
 * - a memory limit of its own, because it runs two small listeners and not an agent.
 */
export function findGatekeeperHardeningViolations({ spaceId, owner, container, outerNetwork }) {
  const innerName = spaceResourceName(spaceId, ROLE_NETWORK);
  const outerName = spaceResourceName(spaceId, ROLE_OUTER_NETWORK);
  const violations = findCommonViolations({
    container,
    tmpfsOptions: GATEKEEPER_TMPFS_OPTIONS,
    networkMode: innerName,
    mountViolations: (mounts) => (mounts.length === 0 ? [] : [{
      check: 'mounts',
      message: `The gatekeeper has ${mounts.length} mount(s) and must have none: ${mounts.map((mount) => mount.Destination).join(', ')}`,
    }]),
    allowedEnvironment: GATEKEEPER_ENVIRONMENT_NAMES,
  });
  const violate = (check, message) => violations.push({ check, message });

  const host = container?.HostConfig ?? {};
  // The limit is ours and fixed, unlike a space's, so an exact value is the honest check.
  if (host.Memory > 0 && host.Memory !== GATEKEEPER_MEMORY_BYTES) {
    violate('memory_limit', `The memory limit is ${host.Memory} bytes, expected ${GATEKEEPER_MEMORY_BYTES}`);
  }

  const networks = container?.NetworkSettings?.Networks ?? {};
  // Exactly these two, by name. The inner network itself is the space checker's business, and
  // every caller of this function runs that one beside it.
  if (Object.keys(networks).sort().join(' ') !== [innerName, outerName].sort().join(' ')) {
    violate('networks', `Attached to [${Object.keys(networks).join(', ')}], expected the inner and the outer network of this space`);
  }
  // The space reaches the corridor under this name and under no other.
  if (networks[innerName] && !aliasesOf(networks[innerName]).includes(GATEKEEPER_ALIAS)) {
    violate('alias', `The gatekeeper is not reachable as '${GATEKEEPER_ALIAS}' on the inner network of this space`);
  }
  // The outer network is the way out, so `Internal` would leave the corridor with nowhere to go.
  if (outerNetwork?.Internal === true) violate('outer_network', 'The outer network of this space cannot reach outside, so the corridor would have no way out');
  const outerLabels = parseSpaceLabels(outerNetwork?.Labels);
  if (outerLabels?.id !== spaceId || outerLabels?.owner !== owner || outerLabels?.role !== ROLE_OUTER_NETWORK) {
    violate('outer_network_labels', 'The outer network does not carry the labels of this space');
  }

  return violations.map(({ check, message }) => ({ check: `gatekeeper_${check}`, message: `Gatekeeper: ${message}` }));
}
