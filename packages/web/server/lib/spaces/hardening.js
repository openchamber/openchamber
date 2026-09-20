import { SpaceError } from './errors.js';
import { ROLE_NETWORK, parseSpaceLabels, requireSpaceId, spaceResourceName, spaceResourcePrefix } from './labels.js';

export const SPACE_USER = '1000:1000';
const SPACE_HOME = '/home/space';
const SPACE_PIDS_LIMIT = 512;
const SPACE_SHM_BYTES = 64 * 1024 * 1024;
const TMPFS_OPTIONS = 'rw,exec,nosuid,size=256m';
const MIN_MEMORY_BYTES = 64 * 1024 * 1024;
const SETUP_MEMORY_BYTES = 128 * 1024 * 1024;

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

const spaceWorkPath = (spaceId) => `/spaces/${requireSpaceId(spaceId)}`;

const volumeMount = (volume, destination) => ['--mount', `type=volume,src=${volume},dst=${destination}`];

// Equal values mean swap adds nothing on top of the limit.
const memoryArgs = (bytes) => ['--memory', String(bytes), '--memory-swap', String(bytes)];

export function requireMemoryBytes(value) {
  if (!Number.isSafeInteger(value) || value < MIN_MEMORY_BYTES) {
    throw new SpaceError('invalid_memory_limit', `A space needs a memory limit of at least ${MIN_MEMORY_BYTES} bytes`);
  }
  return value;
}

/** The `docker network create` argv for the network of a space. */
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
 * The full `docker create` argv for a space container. Every restriction here has
 * a matching check in findHardeningViolations.
 */
export function buildSpaceCreateArgs({ spaceId, containerName, labelArguments, network, workVolume, homeVolume, memoryBytes, image, command }) {
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
    '--env', `HOME=${SPACE_HOME}`,
    image,
    ...command,
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
    'chown', SPACE_USER, spaceWorkPath(spaceId), SPACE_HOME,
  ];
}

const mentionsRuntimeSocket = (text) => String(text ?? '').includes('docker.sock');

/**
 * Compares the parsed `docker inspect` entry of a space container and of its
 * network with the requested hardening. Returns one `{ check, message }` per
 * difference. An empty list means the space is verified.
 *
 * Docker fills every field read here at `docker create`, so this runs before the
 * container starts.
 */
export function findHardeningViolations({ spaceId, owner, container, network }) {
  const violations = [];
  const violate = (check, message) => violations.push({ check, message });

  const config = container?.Config ?? {};
  const host = container?.HostConfig ?? {};
  const mounts = container?.Mounts ?? [];
  const prefix = spaceResourcePrefix(spaceId);
  const networkName = spaceResourceName(spaceId, ROLE_NETWORK);

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
  if (Object.keys(tmpfs).length !== 1 || !TMPFS_OPTIONS.split(',').every((option) => tmpOptions.includes(option))) {
    violate('tmpfs', 'The only tmpfs must be /tmp with nosuid and a size limit');
  }

  if ((host.Binds ?? []).length > 0) violate('binds', `Host paths are mounted: ${host.Binds.join(', ')}`);
  if ((host.VolumesFrom ?? []).length > 0) violate('volumes_from', 'Volumes of another container are attached');
  for (const mount of mounts) {
    if (mount.Type !== 'volume' || !String(mount.Name ?? '').startsWith(prefix)) {
      violate('mounts', `Mount at ${mount.Destination} is not a volume of this space`);
    }
  }
  const socketMounted = mounts.some((mount) => mentionsRuntimeSocket(mount.Source) || mentionsRuntimeSocket(mount.Destination))
    || (host.Binds ?? []).some(mentionsRuntimeSocket);
  if (socketMounted) violate('runtime_socket', 'The container runtime socket is mounted');

  for (const field of NAMESPACE_FIELDS) {
    if (!PRIVATE_NAMESPACE_MODES.includes(host[field] ?? '')) violate('namespace', `${field} is '${host[field]}', which is not private`);
  }
  if (host.NetworkMode !== networkName) violate('network_mode', `NetworkMode is '${host.NetworkMode ?? ''}', expected the network of this space`);
  if (Object.keys(host.Sysctls ?? {}).length > 0) violate('sysctls', 'Kernel parameters were changed');
  if (!['', 'runc'].includes(host.Runtime ?? '')) violate('runtime', `Unexpected container runtime '${host.Runtime}'`);
  if ((host.Devices ?? []).length > 0) violate('devices', 'Host devices are attached');
  if (Object.keys(host.PortBindings ?? {}).length > 0) violate('port_bindings', 'Ports are published on the host');

  const attached = Object.keys(container?.NetworkSettings?.Networks ?? {});
  if (attached.length !== 1 || attached[0] !== networkName) {
    violate('networks', `Attached to [${attached.join(', ')}], expected only the network of this space`);
  }
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
