import path from 'node:path';
import { EXIT_RECORDER_PROGRAM } from './record-exit.js';
import { GATEKEEPER_COMMAND, GATEKEEPER_ENVIRONMENT, SPACE_ENVIRONMENT, SPACE_HOME, SPACE_SERVER_COMMAND, TOOLS_MOUNT_PATH, spaceWorkPath } from '../spaces/layout.js';
import { SUBJECT_BIND_PATH, layout as protectedMcpLayout } from '../protected-mcp/service/install-layout.js';

const MCP_SUBJECTS_PATH = protectedMcpLayout().live.subjectsDir;

export const MARKER = '# Managed by OpenChamber hostd.\n';
export const names = (id) => ({ space: `openchamber-space-${id}.service`, gatekeeper: `openchamber-gk-${id}.service`, net: `openchamber-net-${id}.service`, slice: `openchamber-space-${id}.slice` });
export const unitQuote = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}"`;

/**
 * Where a space's work and home are bound from. hostd makes both under the private state folder.
 * For a DynamicUser space, systemd's StateDirectory links the public folder there. A root space has
 * no DynamicUser, so systemd would make that public folder a plain empty one: it binds the private
 * folder directly and has no StateDirectory.
 */
export const stateSource = (paths, record) => `${record.place === 'host-root' ? paths.privateState : paths.spaceState}/${record.id}`;

const HARDENING = Object.freeze([
  ['ProtectSystem', 'strict'], ['ProtectHome', 'tmpfs'], ['PrivateTmp', 'yes'],
  ['TemporaryFileSystem', '/run:rw,nosuid,nodev,noexec,size=16M /srv:ro /mnt:ro /media:ro /spaces:ro /opt:ro /dev/shm:rw,nosuid,nodev,noexec,size=64M,mode=1777'],
  ['PrivateDevices', 'yes'], ['PrivateIPC', 'yes'], ['ProtectProc', 'invisible'], ['ProcSubset', 'pid'],
  ['ProtectKernelTunables', 'yes'], ['ProtectKernelModules', 'yes'], ['ProtectKernelLogs', 'yes'],
  ['ProtectControlGroups', 'yes'], ['ProtectClock', 'yes'], ['ProtectHostname', 'yes'],
  ['RestrictNamespaces', 'yes'], ['RestrictSUIDSGID', 'yes'], ['LockPersonality', 'yes'],
  ['NoNewPrivileges', 'yes'], ['CapabilityBoundingSet', ''], ['AmbientCapabilities', ''],
  ['SystemCallArchitectures', 'native'], ['SystemCallFilter', '@system-service'],
  ['RestrictAddressFamilies', 'AF_UNIX AF_INET AF_INET6 AF_NETLINK'], ['KeyringMode', 'private'],
  ['UMask', '0022'], ['MemorySwapMax', '0'], ['TasksMax', '512'], ['OOMPolicy', 'continue'],
]);

export function targetProperties({ record, paths, target }) {
  const id = record.id;
  const gatekeeper = target === 'gatekeeper';
  const root = !gatekeeper && record.place === 'host-root';
  const directory = path.join(paths.pins, id);
  const identity = `openchamber-${gatekeeper ? 'gk' : 'space'}-${id}`;
  const toolsBin = `${TOOLS_MOUNT_PATH}/node_modules/.bin`;
  const environment = gatekeeper ? { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...GATEKEEPER_ENVIRONMENT } : { ...SPACE_ENVIRONMENT, PATH: [toolsBin, ...SPACE_ENVIRONMENT.PATH.split(':').filter((entry) => entry !== toolsBin)].join(':') };
  // A key, never `undefined`: every entry becomes an Environment= line.
  if (!gatekeeper && record.startConfig !== null) environment.OPENCODE_CONFIG_CONTENT = record.startConfig;
  return [
    ['Slice', names(id).slice],
    ...(root ? [['User', 'root']] : [['DynamicUser', 'yes'], ['User', identity], ['Group', identity], ...HARDENING]),
    ['NetworkNamespacePath', gatekeeper ? path.join(directory, 'net') : `/run/netns/ocs-${id}`],
    ['MemoryMax', String(gatekeeper ? 256 * 1024 * 1024 : record.memoryBytes)],
    ['PrivateTmp', 'yes'],
    ['BindReadOnlyPaths', `/usr/bin/node:/usr/local/bin/node ${directory}/${target}.hostname:/etc/hostname ${directory}/${gatekeeper ? 'resolv.conf' : 'space-resolv.conf'}:/etc/resolv.conf`],
    ...(gatekeeper ? [['BindReadOnlyPaths', `${directory}/gatekeeper-hosts:/etc/hosts`]] : [
      ...(!root ? [['StateDirectory', `openchamber-spaces/${id}`], ['StateDirectoryMode', '0700'],
        ['ReadOnlyPaths', `${paths.spaceState}/${id} ${paths.privateState}/${id}`]] : []),
      ['BindPaths', `${stateSource(paths, record)}/work:${spaceWorkPath(id)} ${stateSource(paths, record)}/home:${SPACE_HOME}`],
      ['BindReadOnlyPaths', `${paths.tools}/${record.toolsKey}:${TOOLS_MOUNT_PATH} ${directory}/hosts:/etc/hosts`],
      // The space's own subject of the protected MCP service: one socket, which opens only the
      // connections granted to this space. Skipped while the service has no such subject.
      ['BindReadOnlyPaths', `-${MCP_SUBJECTS_PATH}/space-${id}:${SUBJECT_BIND_PATH}`],
      ['WorkingDirectory', spaceWorkPath(id)],
    ]),
    ...Object.entries(environment).map(([key, value]) => ['Environment', `${key}=${value}`]),
    ['LogRateLimitIntervalSec', '30s'], ['LogRateLimitBurst', '1000'],
  ];
}

function serviceText(properties, argv, { stopPost = null } = {}) {
  return `${MARKER}[Unit]\nDescription=OpenChamber host space\n\n[Service]\nType=exec\n${properties.map(([key, value]) => `${key}=${key === 'Environment' ? unitQuote(value) : value}`).join('\n')}\nExecStart=:${argv.map(unitQuote).join(' ')}\nTimeoutStopSec=15\nKillMode=control-group\n${stopPost === null ? '' : `ExecStopPost=+${stopPost}\n`}`;
}

export function buildUnits({ record, paths, ipPath }) {
  void ipPath;
  const id = record.id;
  const unit = names(id);
  const directory = path.join(paths.pins, id);
  const netUser = `openchamber-net-${id}`;
  const netProperties = [
    ['Slice', unit.slice], ['User', netUser], ['Group', netUser],
    ['RuntimeDirectory', `openchamber-net-${id}`], ['RuntimeDirectoryMode', '0700'],
    ['BindReadOnlyPaths', `${directory}/user:/run/openchamber-net-${id}/user ${directory}/net:/run/openchamber-net-${id}/net`],
    ['NoNewPrivileges', 'yes'], ['CapabilityBoundingSet', ''], ['AmbientCapabilities', ''],
    ['ProtectSystem', 'strict'], ['ProtectHome', 'yes'], ['PrivateTmp', 'yes'],
    ['ProtectKernelTunables', 'yes'], ['ProtectKernelModules', 'yes'], ['ProtectKernelLogs', 'yes'],
    ['ProtectControlGroups', 'yes'], ['ProtectClock', 'yes'], ['ProtectHostname', 'yes'],
    ['RestrictSUIDSGID', 'yes'], ['LockPersonality', 'yes'], ['MemoryDenyWriteExecute', 'yes'],
    ['RestrictRealtime', 'yes'], ['SystemCallArchitectures', 'native'],
    ['MemoryMax', '134217728'], ['MemorySwapMax', '0'], ['TasksMax', '32'],
    ['LogRateLimitIntervalSec', '30s'], ['LogRateLimitBurst', '1000'],
  ];
  const stopPost = `/usr/bin/node -e ${unitQuote(EXIT_RECORDER_PROGRAM)} ${id} $SERVICE_RESULT $EXIT_CODE $EXIT_STATUS`;
  return {
    [unit.slice]: `${MARKER}[Slice]\nMemoryMax=${record.memoryBytes}\nMemorySwapMax=0\nTasksMax=512\n`,
    [unit.net]: serviceText(netProperties, ['/usr/bin/slirp4netns', '--configure', '--mtu=65520', '--disable-host-loopback', '--enable-seccomp', `--userns-path=/run/openchamber-net-${id}/user`, '--netns-type=path', `/run/openchamber-net-${id}/net`, 'tap0']),
    [unit.gatekeeper]: serviceText(targetProperties({ record, paths, target: 'gatekeeper' }), GATEKEEPER_COMMAND),
    [unit.space]: serviceText(targetProperties({ record, paths, target: 'space' }), SPACE_SERVER_COMMAND, { stopPost }),
  };
}

export function execArguments({ record, paths, target, unit, argv }) {
  const properties = [
    ...targetProperties({ record, paths, target }), ['JoinsNamespaceOf', names(record.id)[target]], ['PrivateTmp', 'yes'],
    ['Requisite', names(record.id)[target]], ['After', names(record.id)[target]], ['PartOf', names(record.id)[target]],
    ['KillMode', 'control-group'], ['TimeoutStopSec', '5s'],
  ];
  return ['--pipe', '--wait', '--quiet', '--expand-environment=no', `--unit=${unit}`,
    ...properties.flatMap(([key, value]) => key === 'RestrictAddressFamilies'
      ? value.split(' ').map((family) => `--property=${key}=${family}`)
      : [`--property=${key}=${value}`]), '--', '/usr/bin/env', '--', ...argv];
}

export function exitCode(properties) {
  if (properties.Result === 'oom-kill') return 137;
  const status = Number(properties.ExecMainStatus);
  const code = Number(properties.ExecMainCode);
  if (!Number.isInteger(status) || status < 0 || status > 255 || ![1, 2, 3].includes(code)) return 1;
  return code === 1 ? status : 128 + status;
}
