import fs from 'node:fs/promises';
import path from 'node:path';
import { names, stateSource } from './units.js';
import { showUnit, checked } from './system.js';
import { addresses } from './state.js';

const LOCKED = Object.freeze({
  DynamicUser: 'yes', ProtectSystem: 'strict', ProtectHome: 'tmpfs', PrivateTmp: 'yes', PrivateDevices: 'yes', PrivateIPC: 'yes',
  ProtectProc: 'invisible', ProcSubset: 'pid', ProtectKernelTunables: 'yes', ProtectKernelModules: 'yes', ProtectKernelLogs: 'yes',
  ProtectControlGroups: 'yes', ProtectClock: 'yes', ProtectHostname: 'yes', RestrictSUIDSGID: 'yes', LockPersonality: 'yes',
  NoNewPrivileges: 'yes', CapabilityBoundingSet: '', AmbientCapabilities: '', SystemCallArchitectures: 'native',
  KeyringMode: 'private', UMask: '0022', MemorySwapMax: '0', TasksMax: '512', OOMPolicy: 'continue',
});

function findUnitViolations({ record, target, inspected, paths, allowedSyscalls }) {
  const violations = [];
  const prefix = target === 'gatekeeper' ? 'gatekeeper_' : '';
  const violation = (check, message) => violations.push({ check: `${prefix}${check}`, message });
  if (inspected.LoadState !== 'loaded') { violation('missing', `The ${target} unit is not loaded`); return violations; }
  if (inspected.FragmentPath !== path.join(paths.units, names(record.id)[target]) || inspected.DropInPaths) violation('unit_source', 'Unexpected unit source or drop-in');
  const root = record.place === 'host-root' && target === 'space';
  if (!root) {
    for (const [key, expected] of Object.entries(LOCKED)) if (inspected[key] !== expected) violation(key, `${target} ${key} is ${inspected[key]}, expected ${expected}`);
    if (!['yes', '~'].includes(inspected.RestrictNamespaces)) violation('namespaces', 'Namespace creation is allowed');
    // systemd-analyze includes architecture aliases libseccomp may omit when loading a unit.
    // A narrower kernel allowlist stays safe; every interpreted syscall must belong to the group.
    const calls = String(inspected.SystemCallFilter).split(' ');
    if (!allowedSyscalls || !['read', 'write', 'execve', 'mmap'].every((call) => calls.includes(call)) || calls.some((call) => !allowedSyscalls.has(call))) violation('syscalls', 'The interpreted system-service syscall allowlist differs');
    if (String(inspected.RestrictAddressFamilies).split(' ').sort().join(' ') !== 'AF_INET AF_INET6 AF_NETLINK AF_UNIX') violation('address_families', 'Unexpected socket address families');
    for (const mount of ['/run', '/srv', '/mnt', '/media', '/spaces', '/opt', '/dev/shm']) if (!String(inspected.TemporaryFileSystem).includes(`${mount}:`)) violation('private_filesystem', `${mount} is not private`);
  }
  const user = root ? 'root' : `openchamber-${target === 'space' ? 'space' : 'gk'}-${record.id}`;
  if (inspected.User !== user) violation('user', 'The target identity differs');
  if (inspected.Slice !== names(record.id).slice) violation('slice', 'The target does not share its space resource limit');
  if (inspected.MemoryMax !== String(target === 'gatekeeper' ? 256 * 1024 * 1024 : record.memoryBytes)) violation('memory', 'The target memory limit differs');
  const namespace = target === 'gatekeeper' ? path.join(paths.pins, record.id, 'net') : `/run/netns/ocs-${record.id}`;
  if (inspected.NetworkNamespacePath !== namespace) violation('network_namespace', 'The target network namespace differs');
  if (target === 'space') {
    if (!root) for (const source of [`${paths.spaceState}/${record.id}`, `${paths.privateState}/${record.id}`]) {
      if (!String(inspected.ReadOnlyPaths).split(' ').includes(source)) violation('state_source_parent', 'The space state source parent is mutable');
    }
    if (!root && (inspected.StateDirectory !== `openchamber-spaces/${record.id}` || inspected.StateDirectoryMode !== '0700')) violation('state', 'The private space state differs');
    for (const item of [`${stateSource(paths, record)}/work:/spaces/${record.id}`, `${stateSource(paths, record)}/home:/home/space`]) if (!String(inspected.BindPaths).includes(item)) violation('state_binds', 'The space state bind is absent');
    if (!String(inspected.BindReadOnlyPaths).includes(`${paths.tools}/${record.toolsKey}:/opt/openchamber-tools`)) violation('tools_mount', 'The read-only tools mount differs');
  }
  return violations;
}

export async function verifySpace({ system, paths, record, ipPath, running = false, networkExpected = running }) {
  const violations = [];
  const groups = new Map();
  let group;
  for (const line of (await checked(system, '/usr/bin/systemd-analyze', ['syscall-filter'])).split('\n')) {
    if (line.startsWith('@')) { group = []; groups.set(line.trim(), group); }
    else if (line.trim() && !line.trim().startsWith('#')) group?.push(line.trim());
  }
  const expanded = new Set();
  const expand = (name) => {
    if (!name.startsWith('@')) { expanded.add(name); return; }
    const entries = groups.get(name);
    if (!entries) throw new Error(`Unknown systemd syscall group ${name}`);
    for (const entry of entries) expand(entry);
  };
  expand('@system-service');
  const allowedSyscalls = expanded;
  for (const target of ['gatekeeper', 'space']) violations.push(...findUnitViolations({ record, target, inspected: await showUnit(system, names(record.id)[target]), paths, allowedSyscalls }));
  const slice = await showUnit(system, names(record.id).slice);
  if (slice.MemoryMax !== String(record.memoryBytes) || slice.MemorySwapMax !== '0' || slice.TasksMax !== '512') violations.push({ check: 'slice_limits', message: 'The shared space resource limits differ' });
  const net = await showUnit(system, names(record.id).net);
  if (net.User !== `openchamber-net-${record.id}` || net.CapabilityBoundingSet !== '' || net.AmbientCapabilities !== '' || net.NoNewPrivileges !== 'yes') violations.push({ check: 'slirp_identity', message: 'The egress service has unexpected authority' });
  for (const file of [paths.state, paths.metadata, paths.pins, ...(networkExpected ? [path.join(paths.pins, record.id)] : [])]) {
    const stat = await fs.stat(file);
    if (stat.uid !== 0 || (stat.mode & 0o077) !== 0) violations.push({ check: 'state_permissions', message: `${file} is not private root-owned state` });
  }
  if (!networkExpected) return violations;
  const inspectNetwork = (args) => checked(system, '/usr/bin/nsenter', [`--net=/run/netns/ocs-${record.id}`, '--', ipPath, ...args]);
  const links = JSON.parse(await inspectNetwork(['-j', 'address', 'show']));
  const ips = addresses(record.subnet);
  if (links.length !== 2 || !links.some((link) => link.ifname === `vs-${record.id}` && link.addr_info.some((address) => address.local === ips.space && address.prefixlen === 30))) violations.push({ check: 'space_network', message: 'The space is not on its private veth /30' });
  const routes = JSON.parse(await inspectNetwork(['-j', 'route', 'show']));
  if (routes.some((route) => route.gateway || route.dst === 'default')) violations.push({ check: 'space_route', message: 'The space has a route outside its veth' });
  const forwarding = await checked(system, '/usr/bin/nsenter', [`--net=${paths.pins}/${record.id}/net`, '--', '/bin/cat', '/proc/sys/net/ipv4/ip_forward']);
  if (forwarding.trim() !== '0') violations.push({ check: 'gatekeeper_forwarding', message: 'The gatekeeper forwards raw IP traffic' });
  if (running && net.ActiveState !== 'active') violations.push({ check: 'slirp_missing', message: 'The egress service is stopped' });
  return violations;
}
