#!/usr/bin/env node
// Installs, updates and removes the protected MCP service on a Linux host.
// Run by a person as root; never by the running OpenChamber.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProtectedMcpError } from './contract.js';
import { createIntegrity } from './integrity.js';
import { ROOT_EQUIVALENT_SOCKETS, runPreflight } from './preflight.js';
import { copyTree, ensureRootDirectory, replaceSymlink, sourceFiles, writeRootFile } from './install-files.js';
import { ADMIN_GROUP, CLIENT_GROUP, layout, SERVICE_USER, SUBJECT_BIND_PATH, tmpfilesFile, UNIT_NAME, unitFile } from './install-layout.js';
import { createSystem } from './install-system.js';
import { readJson } from './state-files.js';
export { layout } from './install-layout.js';

const MIN_NODE = [24, 14];

const refuse = (code, message) => {
  throw new ProtectedMcpError(code, { status: 500, message });
};

const integrityFor = (system, engine) => createIntegrity({ owners: system.trustedOwners, groups: [0], engine });

async function requireTrusted(system, engine, target, code) {
  const { findings } = await integrityFor(system, engine).inspect(target);
  if (findings.length > 0) refuse(code, `${target}: ${findings.map((finding) => `${finding.code} ${finding.subject}`).join(', ')}`);
}

const parseVersion = (text) => {
  const match = /^v(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
};

const NODE_CANDIDATES = ['/usr/bin/node', '/usr/local/bin/node'];

/** A Node.js the engine cannot replace, recent enough for the service. */
async function trustedNode(system, engine, root, requested) {
  for (const candidate of requested ? [requested] : NODE_CANDIDATES) {
    const target = path.join(root, candidate);
    try {
      await fs.access(target);
    } catch {
      continue;
    }
    await requireTrusted(system, engine, target, 'untrusted_node');
    const version = parseVersion(await system.nodeVersion(target));
    if (!version || version[0] < MIN_NODE[0] || (version[0] === MIN_NODE[0] && version[1] < MIN_NODE[1])) {
      refuse('node_too_old', `${candidate} must be Node.js ${MIN_NODE.join('.')} or newer`);
    }
    return { live: candidate, local: target };
  }
  return refuse('node_missing', 'Install Node.js system-wide, owned by root, then run this again');
}

const NPM_CANDIDATES = ['/usr/lib/node_modules/npm/bin/npm-cli.js', '/usr/local/lib/node_modules/npm/bin/npm-cli.js'];

async function trustedNpm(system, engine, root, node) {
  for (const candidate of NPM_CANDIDATES) {
    const target = path.join(root, candidate);
    try {
      await fs.access(target);
    } catch {
      continue;
    }
    const { findings } = await integrityFor(system, engine).inspect(target);
    if (findings.length === 0) return [node, candidate];
  }
  return null;
}

/**
 * Installs or updates the service. Configuration and state survive an update;
 * the previous version stays on disk as `previous` for a rollback.
 *
 * `engineUser` is the account agents run as. Without `adminUser` it is also the
 * OpenChamber account and joins both groups, as in stage 1. With an `adminUser`
 * of its own, that account (OpenChamber) joins both groups and the engine joins
 * neither: agents then reach only the subject socket their unit binds.
 */
export async function install({ root = '/', source, version, engineUser, adminUser = null, engineUnit = null, node: requestedNode = null, start = true, acceptUnprotected = false, system = createSystem(), say = () => {} }) {
  const paths = layout(root);
  if (!system.isRoot()) refuse('root_required', 'Run the installer as root');
  if (start && !await system.hasSystemd()) refuse('systemd_required', 'The protected MCP service needs systemd');
  if (!/^[0-9A-Za-z.+-]{1,64}$/.test(version ?? '')) refuse('invalid_version', 'invalid version');
  if (!engineUser || engineUser.startsWith('--')) refuse('engine_user_required', 'Specify --engine-user with the OpenChamber account');
  if (adminUser !== null && (!adminUser || adminUser.startsWith('--'))) refuse('admin_user_invalid', 'Specify --admin-user with the OpenChamber account');
  const engine = await system.identity(engineUser);
  if (engine.uid === 0) refuse('engine_is_root', 'The engine account must not be root');
  const separate = adminUser !== null && adminUser !== engineUser;
  const admin = separate ? await system.identity(adminUser) : null;
  if (admin?.uid === 0) refuse('admin_is_root', 'OpenChamber must not run as root');
  const accounts = admin ? [engine, admin] : [engine];
  const requireTrustedByAll = async (target, code) => {
    for (const account of accounts) await requireTrusted(system, account, target, code);
  };

  await requireTrustedByAll(source, 'untrusted_source');
  const files = await sourceFiles(source);
  for (const file of files) await requireTrustedByAll(path.join(source, file), 'untrusted_source');
  const node = await trustedNode(system, engine, root, requestedNode);
  if (admin) await requireTrusted(system, admin, node.local, 'untrusted_node');
  const npm = await trustedNpm(system, engine, root, node.live);
  const existing = await readJson(paths.serviceConfig);

  const clientGid = await system.ensureGroup(CLIENT_GROUP);
  const adminGid = await system.ensureGroup(ADMIN_GROUP);
  const serviceUid = await system.ensureUser(SERVICE_USER, { home: paths.live.stateDir });
  const serviceGid = await system.ensureGroup(SERVICE_USER);
  const members = separate ? adminUser : engineUser;
  await system.addToGroup(members, CLIENT_GROUP);
  await system.addToGroup(members, ADMIN_GROUP);
  const leaving = new Set([existing?.engineUser, existing?.adminUser, separate ? engineUser : null]
    .filter((account) => account && account !== members));
  for (const account of leaving) {
    await system.removeFromGroup(account, CLIENT_GROUP);
    await system.removeFromGroup(account, ADMIN_GROUP);
    say(`Account ${account} is in neither ${CLIENT_GROUP} nor ${ADMIN_GROUP}.`);
  }
  say(`Account ${SERVICE_USER} and group ${CLIENT_GROUP} are ready; ${members} is in ${CLIENT_GROUP} and ${ADMIN_GROUP}.`);
  say(separate
    ? `OpenChamber runs as ${adminUser} and administers protected MCP; agents run as ${engineUser} and call only the connections granted to their subject.`
    : `In stage 1 OpenChamber runs as the engine account ${engineUser}, which administers protected MCP through ${ADMIN_GROUP}.`);

  await ensureRootDirectory(system, paths.installDir, { own: true });
  const versionDir = path.join(paths.installDir, version);
  const digest = await copyTree({ system, source, files, target: versionDir, version });
  const currentLink = path.join(paths.installDir, 'current');
  const previousTarget = await fs.readlink(currentLink).catch(() => null);
  if (previousTarget && previousTarget !== version) await replaceSymlink(path.join(paths.installDir, 'previous'), previousTarget);
  await replaceSymlink(currentLink, version);
  await requireTrustedByAll(path.join(versionDir, 'lib', 'protected-mcp', 'service', 'main.js'), 'installed_tree_untrusted');

  const serviceConfig = {
    version: 1,
    serviceVersion: version,
    stateDir: paths.live.stateDir,
    engineSocket: paths.live.engineSocket,
    subjectsDir: existing?.subjectsDir ?? paths.live.subjectsDir,
    engineSocketGroup: clientGid,
    engineUser,
    adminUser: separate ? adminUser : null,
    engineUnit: engineUnit ?? existing?.engineUnit ?? null,
    adminSocket: paths.live.adminSocket,
    adminSocketGroup: adminGid,
    workerPath: '/usr/local/bin:/usr/bin:/bin',
    node: node.live,
    npm,
    installDir: paths.live.installDir,
    configDir: paths.live.configDir,
  };
  await writeRootFile(system, paths.serviceConfig, `${JSON.stringify(serviceConfig, null, 2)}\n`);
  const relay = [node.live, `${paths.live.installDir}/current/lib/protected-mcp/service/relay.js`];
  await writeRootFile(system, paths.clientConfig, `${JSON.stringify({
    version: 1,
    socket: paths.live.engineSocket,
    adminSocket: paths.live.adminSocket,
    relay,
  }, null, 2)}\n`);
  if (separate) {
    await writeRootFile(system, paths.agentClientConfig, `${JSON.stringify({
      version: 1,
      socket: `${SUBJECT_BIND_PATH}/engine.sock`,
      adminSocket: paths.live.adminSocket,
      relay,
    }, null, 2)}\n`);
  } else {
    await fs.rm(paths.agentClientConfig, { force: true });
  }

  await ensureRootDirectory(system, path.dirname(paths.stateDir));
  await fs.mkdir(paths.stateDir, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await fs.chmod(paths.stateDir, 0o700);
  for (const entry of await fs.readdir(paths.stateDir, { recursive: true })) await system.chown(path.join(paths.stateDir, entry), serviceUid, serviceGid);
  await system.chown(paths.stateDir, serviceUid, serviceGid);

  await writeRootFile(system, paths.unitFile, unitFile({ node: node.live, live: paths.live }), { own: false });
  if (separate) await writeRootFile(system, paths.tmpfilesFile, tmpfilesFile({ subjectsDir: serviceConfig.subjectsDir }), { own: false });
  else await fs.rm(paths.tmpfilesFile, { force: true });

  const preflight = await runPreflight({
    integrity: integrityFor(system, engine),
    engine,
    engineUser,
    engineUnit: serviceConfig.engineUnit,
    trustedPaths: [node.local, ...(npm ? [path.join(root, npm[1])] : [])],
    trustedTrees: [versionDir, paths.configDir],
    privateDirectories: [paths.stateDir],
    sockets: system.sockets ?? ROOT_EQUIVALENT_SOCKETS.map((socket) => path.join(root, socket)),
    socketOwners: system.socketOwners,
  });
  if (preflight.status === 'unprotected' && !acceptUnprotected) {
    refuse('unprotected', `The engine can reach root: ${preflight.findings.filter((finding) => finding.level === 'error').map((finding) => `${finding.code} ${finding.subject ?? ''}`.trim()).join(', ')}. Fix it, or rerun with --accept-unprotected to install anyway.`);
  }

  let status = null;
  if (start) {
    // Now as at every boot: the agents' unit, restarted next, finds its subject folder to bind.
    if (separate) await system.createTmpfiles(paths.tmpfilesFile);
    await system.systemctl(['daemon-reload']);
    await system.systemctl(['enable', UNIT_NAME]);
    await system.systemctl(['restart', UNIT_NAME]);
    for (let attempt = 0; attempt < 30 && status === null; attempt += 1) {
      status = await system.connect(paths.engineSocket).catch(() => null);
      if (status === null) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (status === null) refuse('service_not_answering', `systemctl status ${UNIT_NAME} tells why`);
  }
  return { version, digest, preflight, status, previous: previousTarget };
}

/** Removes the service. Credentials, the account and its group stay unless `purgeState` is set. */
export async function uninstall({ root = '/', engineUser = null, adminUser = null, purgeState = false, system = createSystem() }) {
  const paths = layout(root);
  if (!system.isRoot()) refuse('root_required', 'Run the installer as root');
  await system.systemctl(['disable', '--now', UNIT_NAME]).catch(() => {});
  await fs.rm(paths.unitFile, { force: true });
  await fs.rm(paths.tmpfilesFile, { force: true });
  await system.systemctl(['daemon-reload']).catch(() => {});
  await fs.rm(paths.installDir, { recursive: true, force: true });
  await fs.rm(paths.clientConfig, { force: true });
  await fs.rm(paths.agentClientConfig, { force: true });
  await fs.rm(paths.serviceConfig, { force: true });
  if (purgeState) {
    await fs.rm(paths.stateDir, { recursive: true, force: true });
    for (const account of new Set([engineUser, adminUser].filter(Boolean))) {
      await system.removeFromGroup(account, CLIENT_GROUP);
      await system.removeFromGroup(account, ADMIN_GROUP);
    }
    await system.removeUser(SERVICE_USER);
    await system.removeGroup(CLIENT_GROUP);
    await system.removeGroup(ADMIN_GROUP);
  }
  return { purged: purgeState };
}

/** Moves `current` back to `previous` after a failed update. */
export async function rollback({ root = '/', system = createSystem() }) {
  const paths = layout(root);
  if (!system.isRoot()) refuse('root_required', 'Run the installer as root');
  const previous = await fs.readlink(path.join(paths.installDir, 'previous')).catch(() => null);
  if (!previous) refuse('no_previous_version', 'There is no earlier version to go back to');
  const current = await fs.readlink(path.join(paths.installDir, 'current'));
  await replaceSymlink(path.join(paths.installDir, 'current'), previous);
  await replaceSymlink(path.join(paths.installDir, 'previous'), current);
  await system.systemctl(['restart', UNIT_NAME]);
  return { current: previous };
}

const USAGE = `Usage: install.js <command> [options]   (as root)

Commands:
  install            Install or update the protected MCP service
  uninstall          Remove it; credentials stay unless --purge-state
  rollback           Go back to the previous version

Options for install:
  --source <dir>         Unpacked @openchamber/web server directory, owned by root
  --version <version>    Version label of that source
  --engine-user <name>   Account OpenCode and the agents run as
  --admin-user <name>    Account OpenChamber runs as, when agents have one of their own
  --engine-unit <unit>   The engine's systemd unit, checked for NoNewPrivileges
  --node <path>          Node.js to run the service (default /usr/bin/node)
  --no-start             Write everything but do not start the service
  --accept-unprotected   Install even when the engine can reach root
\nManage protected MCP servers in OpenChamber: Settings → MCP.
`;

async function cli(argv) {
  const [command, ...rest] = argv;
  const option = (name) => {
    const index = rest.indexOf(name);
    return index === -1 ? null : rest[index + 1] ?? null;
  };
  const flag = (name) => rest.includes(name);
  if (!command || command === '--help' || flag('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const say = (text) => process.stdout.write(`${text}\n`);
  if (command === 'install' || command === 'update') {
    const result = await install({
      source: option('--source'),
      version: option('--version'),
      engineUser: option('--engine-user'),
      adminUser: option('--admin-user'),
      engineUnit: option('--engine-unit'),
      node: option('--node'),
      start: !flag('--no-start'),
      acceptUnprotected: flag('--accept-unprotected'),
      say,
    });
    say(`Installed version ${result.version}.`);
    say(`Boundary status: ${result.preflight.status}${result.preflight.findings.length ? ` (${result.preflight.findings.map((finding) => finding.code).join(', ')})` : ''}.`);
    say('Manage protected MCP servers in OpenChamber: Settings → MCP.');
    say('Restart the OpenChamber service once so its account picks up the new group membership.');
    return 0;
  }
  if (command === 'uninstall') {
    const result = await uninstall({ engineUser: option('--engine-user'), adminUser: option('--admin-user'), purgeState: flag('--purge-state') });
    say(result.purged ? 'Removed the service, its state and its account.' : 'Removed the service. Credentials and the service account stay for a reinstall.');
    return 0;
  }
  if (command === 'rollback') {
    say(`Running version ${(await rollback({})).current}.`);
    return 0;
  }
  process.stderr.write(USAGE);
  return 64;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await fs.realpath(process.argv[1])) {
  cli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`${error.message ?? error}\n`);
    process.exitCode = error.code === 'root_required' ? 77 : 1;
  });
}
