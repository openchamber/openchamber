// Root orchestration for the host install. Data conversion, units and OS operations
// live behind separate boundaries so an update cannot silently enable separation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashUiPassword, normalizeUiPassword } from '../ui-auth/ui-password-hash.js';
import { compareVersions } from '../version-order.js';
import { ensureAccounts, fail, separationConfig } from './accounts.js';
import { setupAgentDocker, setupFrontDoorDocker } from './agent-docker.js';
import { writeAgentLink } from './agent-link.js';
import { deploy, requireOwnUnits } from './host-deploy.js';
import { migrateAccounts } from './migrate-accounts.js';
import { projectSharing } from './root-commands.js';
import { REPO_PATTERN } from './release.js';
import { createSystem, exists, layout, linkedVersion, obtainPackage, prepare, readJson, replaceSymlink, trustedToolchain, writeRootFile } from './host-support.js';
import { AGENT_UNIT, ALL_UNITS, APP_UNIT, HOSTD_SOCKET, HOSTD_UNIT, UPDATER_PATH, UPDATER_TIMER, UPDATER_UNIT } from './host-units.js';
export { layout } from './host-support.js';
export { rollback } from './host-rollback.js';
export { APP_UNIT, UPDATER_UNIT, UPDATER_TIMER, UPDATER_PATH } from './host-units.js';

async function prepareRequestDir(system, paths, front) {
  await fs.mkdir(path.dirname(paths.requestDir), { recursive: true, mode: 0o755 });
  await system.chown(path.dirname(paths.requestDir), 0, 0);
  await fs.chmod(path.dirname(paths.requestDir), 0o755);
  await fs.mkdir(paths.requestDir, { recursive: true, mode: 0o700 });
  await system.chown(paths.requestDir, front.uid, front.gid);
  await fs.chmod(paths.requestDir, 0o700);
}
const UI_PASSWORD_SET = /^OPENCHAMBER_UI_PASSWORD(?:_HASH)?=\S/m;

/**
 * The front door starts only behind its UI password. Answers the line its env file gains, or null
 * when the file sets a password already; refuses, before anything on the host changed, without one.
 * Only the hash is written: the password itself never reaches the disk.
 */
async function uiPasswordLine(paths, readUiPassword) {
  const env = await fs.readFile(paths.envFile, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  if (UI_PASSWORD_SET.test(env)) return null;
  const password = normalizeUiPassword(await readUiPassword() ?? '');
  if (!password) fail('ui_password_required', `OpenChamber runs only behind its UI password. Run this from a terminal to type one, pipe it in with --ui-password-stdin, or put OPENCHAMBER_UI_PASSWORD_HASH=<the output of: openchamber hash-password> in ${paths.live.envFile}, then run this again`);
  return `OPENCHAMBER_UI_PASSWORD_HASH=${hashUiPassword(password)}\n`;
}

async function linkCommand(paths, say) {
  const target = path.join(paths.live.app, 'bin', 'cli.js');
  const existing = await fs.readlink(paths.binLink).catch((error) => error.code === 'ENOENT' ? null : 'other');
  if (existing !== null && existing !== target) { say(`${paths.live.binLink} already exists and was left as it is.`); return; }
  await fs.mkdir(path.dirname(paths.binLink), { recursive: true, mode: 0o755 });
  await replaceSymlink(paths.binLink, target);
}

export async function install({
  root = '/', system = createSystem(), say = () => {}, owner: ownerName, repo, port, host, autoUpdate,
  protectedMcp, acceptUnprotected, tarball = null, version = null, separation, agentUser, agentPort, dryRun = false,
  readUiPassword = async () => null,
}) {
  await prepare(system);
  const paths = layout(root);
  const existing = await readJson(paths.configFile);
  const config = {
    version: 1, owner: ownerName ?? existing?.owner, repo: repo ?? existing?.repo,
    port: port ?? existing?.port ?? 3000, host: host ?? existing?.host ?? '127.0.0.1',
    autoUpdate: autoUpdate ?? existing?.autoUpdate ?? true,
    protectedMcp: protectedMcp ?? existing?.protectedMcp ?? true,
    acceptUnprotected: acceptUnprotected ?? existing?.acceptUnprotected ?? false,
  };
  if (!config.owner || !/^[a-z_][a-z0-9_-]{0,31}$/.test(config.owner)) fail('owner_required', 'Give --owner with the human account that owns the projects');
  if (!REPO_PATTERN.test(config.repo ?? '')) fail('repo_required', 'Give --repo with the GitHub repository whose releases to install, as owner/name');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) fail('invalid_port', `Invalid port ${config.port}`);
  if (!/^[0-9A-Za-z.:-]{1,255}$/.test(config.host)) fail('invalid_host', `Invalid host ${config.host}`);
  const owner = await system.account(config.owner);
  if (owner.uid === 0) fail('owner_is_root', 'OpenChamber must not run as root; give the account of the person who uses it');
  if (existing?.owner && existing.owner !== owner.name) fail('owner_changed', `This host is installed for ${existing.owner}. Uninstall first to change the owner`);
  config.separation = separationConfig({ existing, enabled: separation, owner: config.owner, agentUser, agentPort, port: config.port });
  await requireOwnUnits(paths);
  const toolchain = await trustedToolchain(system, owner, root);
  if (dryRun) {
    if (!config.separation) return { config, dryRun: true };
    // Account creation is part of the plan, never a side effect of a dry run.
    const agent = await system.account(config.separation.agent).catch((error) => { if (error.code === 'owner_unknown') return { name: config.separation.agent, home: `/home/${config.separation.agent}` }; throw error; });
    const accounts = { human: owner, front: { name: 'openchamber', home: '/var/lib/openchamber' }, agent };
    const uiPassword = UI_PASSWORD_SET.test(await fs.readFile(paths.envFile, 'utf8').catch(() => '')) ? 'set' : 'required';
    return { config, dryRun: true, uiPassword, migration: await migrateAccounts({ root, system, accounts, envFile: paths.envFile, dryRun: true, say }) };
  }
  const passwordLine = config.separation ? await uiPasswordLine(paths, readUiPassword) : null;
  const accounts = await ensureAccounts({ system, root, config, say });
  for (const account of [accounts.front, accounts.agent]) await trustedToolchain(system, account, root);
  if (await exists(path.join(root, owner.home, '.config/systemd/user', APP_UNIT))) say(`${owner.name} also has a user unit ${APP_UNIT}. Turn it off as ${owner.name}: systemctl --user disable --now ${APP_UNIT}`);
  const source = await obtainPackage({ system, paths, config, tarball, version });
  let migration;
  let docker;
  try {
    if (!await exists(paths.envFile)) await writeRootFile(system, paths.envFile, '# Environment for OpenChamber, such as OPENCHAMBER_UI_PASSWORD=...\n', 0o600);
    if (passwordLine) {
      const env = await fs.readFile(paths.envFile, 'utf8');
      await writeRootFile(system, paths.envFile, `${env}${env === '' || env.endsWith('\n') ? '' : '\n'}${passwordLine}`, 0o600);
    }
    const beforeStart = async () => {
      if (config.separation) await writeAgentLink({ system, paths, config });
      if (config.separation && !existing?.separation) {
        if (existing) await system.systemctl(['stop', APP_UNIT]);
        migration = await migrateAccounts({ root, system, accounts, envFile: paths.envFile, sharing: projectSharing({ root, system, accounts }), say });
        docker = await setupAgentDocker({ root, system, agent: accounts.agent, say });
        if (docker.status === 'ready') config.separation.docker = true;
        docker.frontDoor = await setupFrontDoorDocker({ root, system, front: accounts.front, say });
        if (docker.frontDoor.status === 'ready') config.separation.frontDocker = true;
      }
      await prepareRequestDir(system, paths, accounts.front);
    };
    const result = await deploy({ system, root, paths, config, previousConfig: existing, owner, accounts, toolchain, tarball: source.tarball, version: source.version, beforeStart, say });
    await linkCommand(paths, say);
    const installed = { ...result, config };
    if (migration) installed.migration = migration;
    if (docker) installed.docker = docker;
    return installed;
  } finally { await source.cleanup(); }
}

async function consumeRequest(paths, say) {
  const entry = await fs.lstat(paths.requestFile).catch(() => null);
  if (!entry) return;
  if (entry.isDirectory()) await fs.rmdir(paths.requestFile).catch(() => say(`${paths.live.requestFile} is a directory that is not empty; remove it to ask for updates again.`));
  else await fs.unlink(paths.requestFile);
}
export async function update({ root = '/', system = createSystem(), say = () => {}, tarball = null, version = null }) {
  await prepare(system);
  const paths = layout(root);
  await consumeRequest(paths, say);
  const config = await readJson(paths.configFile);
  if (!config) fail('not_installed', 'OpenChamber is not installed on this host');
  const current = await linkedVersion(paths, 'current');
  const owner = await system.account(config.owner);
  const toolchain = await trustedToolchain(system, owner, root);
  const release = tarball ? null : await system.findRelease({ repo: config.repo });
  if (release && current && compareVersions(release.version, current) <= 0) { say(`OpenChamber ${current} is up to date.`); return { version: current, updated: false }; }
  if (release && release.version === config.skipVersion) { say(`OpenChamber ${release.version} was rolled back on this host, so ${current} stays.`); return { version: current, updated: false, skipped: release.version }; }
  await requireOwnUnits(paths);
  const accounts = await ensureAccounts({ system, root, config, say });
  const source = await obtainPackage({ system, paths, config, tarball, version, release });
  try {
    const beforeStart = async () => { if (config.separation) await writeAgentLink({ system, paths, config }); };
    const result = await deploy({ system, root, paths, config, previousConfig: config, owner, accounts, toolchain, tarball: source.tarball, version: source.version, beforeStart, say });
    return { ...result, updated: true };
  } finally { await source.cleanup(); }
}
async function removeRequestDir(system, paths) {
  if (!await exists(paths.requestDir)) return;
  await system.chown(paths.requestDir, 0, 0);
  await fs.chmod(paths.requestDir, 0o700);
  for (const entry of await fs.readdir(paths.requestDir, { withFileTypes: true })) {
    const full = path.join(paths.requestDir, entry.name);
    await (entry.isDirectory() ? fs.rmdir(full) : fs.unlink(full)).catch(() => {});
  }
  await fs.rmdir(paths.requestDir).catch(() => {});
  await fs.rmdir(path.dirname(paths.requestDir)).catch(() => {});
}
export async function uninstall({ root = '/', system = createSystem(), say = () => {}, purge = false, purgeAccounts = false }) {
  if (!system.isRoot()) fail('root_required', 'Run this as root');
  if (purgeAccounts && !purge) fail('purge_required', '--purge-accounts also requires --purge');
  const paths = layout(root);
  const config = await readJson(paths.configFile);
  await requireOwnUnits(paths);
  for (const name of [UPDATER_TIMER, UPDATER_PATH, UPDATER_UNIT, APP_UNIT, AGENT_UNIT, HOSTD_UNIT, HOSTD_SOCKET]) await system.systemctl(['disable', '--now', name]).catch(() => {});
  if (config?.protectedMcp !== false) await system.protectedMcp.uninstall({ root, engineUser: config?.separation?.agent ?? config?.owner ?? null, adminUser: config?.separation?.frontDoor, purgeState: purge }).catch((error) => say(`The protected MCP service was not removed: ${error.message}`));
  for (const name of ALL_UNITS) await fs.rm(paths.unit(name), { force: true });
  await system.systemctl(['daemon-reload']).catch(() => {});
  if (await fs.readlink(paths.binLink).catch(() => null) === path.join(paths.live.app, 'bin', 'cli.js')) await fs.rm(paths.binLink, { force: true });
  await fs.rm(paths.wrapper, { force: true });
  await fs.rm(paths.installDir, { recursive: true, force: true });
  await removeRequestDir(system, paths);
  await fs.rm(paths.cacheDir, { recursive: true, force: true });
  await fs.rm(paths.configFile, { force: true });
  if (purge) for (const file of [paths.envFile, paths.agentEnv, paths.agentLink]) await fs.rm(file, { force: true });
  if (purge && purgeAccounts && config?.separation) {
    for (const name of [config.separation.agent, config.separation.frontDoor]) await system.run('userdel', ['--remove', name]);
  }
  say('Removed OpenChamber. Account homes remain unless --purge --purge-accounts was given.');
  return { purged: purge };
}
export async function status({ root = '/', system = createSystem() }) {
  const paths = layout(root);
  const config = await readJson(paths.configFile).catch(() => null);
  if (!config) return { installed: false };
  const units = {};
  for (const name of [APP_UNIT, UPDATER_TIMER, UPDATER_PATH, HOSTD_SOCKET, HOSTD_UNIT, ...(config.separation ? [AGENT_UNIT] : [])]) units[name] = await system.isActive(name);
  return { installed: true, config, current: await linkedVersion(paths, 'current'), previous: await linkedVersion(paths, 'previous'), units };
}
