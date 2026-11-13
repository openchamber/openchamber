import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

/** Sockets whose daemon runs as root and lets a client start privileged containers or VMs. */
export const ROOT_EQUIVALENT_SOCKETS = [
  '/var/run/docker.sock', '/run/docker.sock', '/run/containerd/containerd.sock', '/var/run/containerd/containerd.sock',
  '/run/podman/podman.sock', '/var/run/crio/crio.sock', '/run/buildkit/buildkitd.sock', '/var/run/libvirt/libvirt-sock',
  '/var/snap/lxd/common/lxd/unix.socket', '/var/lib/lxd/unix.socket', '/var/lib/incus/unix.socket',
];
const ROOT_EQUIVALENT_GROUPS = new Set(['disk', 'root']);
const ESCALATION_GROUPS = new Set(['sudo', 'wheel', 'admin']);
const CONTAINER_GROUPS = new Set(['docker', 'lxd', 'incus', 'libvirt']);

const parseGroups = (text) => {
  const byGid = new Map();
  for (const line of text.split('\n')) {
    const [name, , gid] = line.split(':');
    if (name && /^\d+$/.test(gid ?? '')) byGid.set(Number(gid), name);
  }
  return byGid;
};

const canConnect = (stats, engine) => {
  if (stats.uid === engine.uid) return (stats.mode & 0o200) !== 0;
  if (engine.gids.includes(stats.gid)) return (stats.mode & 0o020) !== 0;
  return (stats.mode & 0o002) !== 0;
};

const systemctlShow = (unit) => new Promise((resolve) => {
  execFile('systemctl', ['show', unit, '--property=NoNewPrivileges', '--property=User', '--property=ActiveState'], { timeout: 5000 }, (error, stdout) => {
    if (error) return resolve(null);
    resolve(Object.fromEntries(stdout.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])));
  });
});

/**
 * Turns findings into the status the engine sees. `error` findings mean the
 * engine can reach something that defeats the boundary; `unknown` ones mean a
 * check could not be done. Either way the answer is not `protected`.
 */
function enforcementStatus(findings) {
  if (findings.some((finding) => finding.level === 'error')) return 'unprotected';
  if (findings.some((finding) => finding.level === 'unknown')) return 'unverified';
  return 'protected';
}

/**
 * What the service can establish about its own boundary without root: its
 * trusted paths, sockets and groups that hand the engine root, and how the
 * engine's service is hardened.
 */
export async function runPreflight({ integrity, engine, engineUser, engineUnit = null, adminSocket = null, trustedPaths, trustedTrees = [], privateDirectories, sockets = ROOT_EQUIVALENT_SOCKETS, socketOwners = [0], readGroups = () => fs.readFile('/etc/group', 'utf8'), showUnit = systemctlShow, now = Date.now }) {
  const findings = [];
  const add = (code, level, subject) => findings.push(subject === undefined ? { code, level } : { code, level, subject });
  if (engine.uid === 0) add('engine_is_root', 'error');

  // Paths are checked with their ancestors; trees also with everything below them.
  for (const [target, check] of [...trustedPaths.map((target) => [target, integrity.inspect]), ...trustedTrees.map((target) => [target, integrity.inspectTree])]) {
    const { findings: pathFindings, aclInspected } = await check(target);
    // An ACL that could not be read is a check not done; every other finding is reach the engine has.
    for (const finding of pathFindings) add(finding.code, finding.code === 'acl_unreadable' ? 'unknown' : 'error', finding.subject);
    if (!aclInspected) add('acl_not_inspected', 'unknown', target);
  }
  for (const directory of privateDirectories) {
    try {
      const stats = await fs.stat(directory);
      if ((stats.mode & 0o077) !== 0) add('private_directory_open', 'error', directory);
    } catch {
      add('path_missing', 'error', directory);
    }
  }

  for (const socket of sockets) {
    let stats;
    try {
      stats = await fs.stat(socket);
    } catch (error) {
      // Absent is fine; a socket the service may not even look at could be anything.
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') add('socket_not_inspected', 'unknown', socket);
      continue;
    }
    if (!stats.isSocket() || !socketOwners.includes(stats.uid)) continue;
    if (canConnect(stats, engine)) {
      add('root_equivalent_socket', 'error', socket);
      continue;
    }
    // A named ACL entry can let the engine connect when the mode bits do not.
    let writers;
    try {
      writers = await integrity.aclWriters(socket);
    } catch (error) {
      if (error?.code !== 'acl_unreadable') throw error;
      add('acl_unreadable', 'unknown', socket);
      continue;
    }
    if (writers === null) add('acl_not_inspected', 'unknown', socket);
    else if (writers.length > 0) add('root_equivalent_socket', 'error', socket);
  }

  let groupNames = new Map();
  try {
    groupNames = parseGroups(await readGroups());
  } catch {
    add('groups_unreadable', 'unknown');
  }
  const unit = engineUnit ? await showUnit(engineUnit) : null;
  const unitBlocksEscalation = Boolean(unit && unit.NoNewPrivileges === 'yes' && unit.User === engineUser);
  if (engineUnit && !unit) add('engine_unit_unreadable', 'unknown', engineUnit);
  for (const gid of engine.gids) {
    const name = groupNames.get(gid);
    if (!name) continue;
    if (ROOT_EQUIVALENT_GROUPS.has(name)) add('root_equivalent_group', 'error', name);
    else if (ESCALATION_GROUPS.has(name)) {
      // NoNewPrivileges stops sudo inside the engine's own service, but the
      // same account can still be subverted through its shell files.
      add(unitBlocksEscalation ? 'engine_account_can_administer' : 'engine_can_escalate', unitBlocksEscalation ? 'warning' : 'unknown', name);
    } else if (CONTAINER_GROUPS.has(name)) add('container_group_member', 'warning', name);
  }
  // Administration is a separate observation. Shared administration does not downgrade call protection.
  let administration = 'shared';
  if (adminSocket !== null) {
    try {
      const stats = await fs.stat(adminSocket);
      if (stats.isSocket() && !canConnect(stats, engine)) {
        const writers = await integrity.aclWriters(adminSocket);
        if (writers !== null && writers.length === 0) administration = 'separate';
      }
    } catch {
      // An unobservable socket or ACL cannot establish separate administration.
    }
  }
  return { status: enforcementStatus(findings), administration, checkedAt: now(), findings };
}
