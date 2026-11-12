import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './accounts.js';
import { writeAgentLink } from './agent-link.js';
import { installProtectedMcpFrom, requireOwnUnits } from './host-deploy.js';
import { ALL_UNITS, AGENT_UNIT, APP_UNIT, HOSTD_SOCKET, HOSTD_UNIT, UPDATER_TIMER } from './host-units.js';
import { createSystem, layout, linkedVersion, prepare, readJson, replaceSymlink, writeConfig, writeRootFile } from './host-support.js';

/** A previous package carries its previous account mode and unit contract with it. */
export async function rollback({ root = '/', system = createSystem(), say = () => {} }) {
  await prepare(system);
  const paths = layout(root);
  await requireOwnUnits(paths);
  const previousDir = await fs.readlink(path.join(paths.installDir, 'previous')).catch(() => null);
  if (!previousDir) fail('no_previous_version', 'There is no earlier version to go back to');
  const config = await readJson(paths.configFile);
  if (!config) fail('not_installed', 'OpenChamber is not installed on this host');
  const leaving = await linkedVersion(paths, 'current');
  const currentDir = await fs.readlink(path.join(paths.installDir, 'current'));
  const units = {};
  for (const name of ALL_UNITS) units[name] = await fs.readFile(paths.unit(name), 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  const current = { directory: currentDir, config, units };
  const stored = await readJson(paths.previousDeployment);
  if (stored && stored.directory !== previousDir) fail('previous_deployment_mismatch', 'The previous package does not match its saved deployment');
  if (!stored && config.separation) fail('previous_deployment_missing', 'No previous account-mode snapshot is available; reinstall a verified separated release');
  const previous = stored ?? { directory: previousDir, config, units };
  const previousVersion = await linkedVersion(paths, 'previous');
  const activate = async (snapshot, heldVersion, version) => {
    await replaceSymlink(path.join(paths.installDir, 'current'), snapshot.directory);
    const restored = { ...snapshot.config, skipVersion: heldVersion };
    for (const name of ALL_UNITS) {
      const content = snapshot.units[name];
      if (content == null) {
        await system.systemctl(['disable', name]).catch(() => {});
        await fs.rm(paths.unit(name), { force: true });
      }
      else await writeRootFile(system, paths.unit(name), content);
    }
    if (restored.separation) await writeAgentLink({ system, paths, config: restored });
    await writeConfig(system, paths, restored);
    const owner = await system.account(restored.owner);
    const front = restored.separation ? await system.account(restored.separation.frontDoor) : owner;
    await system.chown(paths.requestDir, front.uid, front.gid);
    await system.systemctl(['daemon-reload']);
    await installProtectedMcpFrom({ system, root, paths, config: restored, owner, appDir: snapshot.directory, version, say });
    if (snapshot.units[HOSTD_SOCKET]) {
      await system.systemctl(['enable', HOSTD_SOCKET]);
      await system.systemctl(['start', HOSTD_SOCKET]);
    }
    if (restored.separation) {
      await system.systemctl(['enable', AGENT_UNIT]);
      await system.systemctl(['restart', AGENT_UNIT]);
    }
    if (snapshot.units[UPDATER_TIMER]) await system.systemctl([restored.autoUpdate ? 'enable' : 'disable', '--now', UPDATER_TIMER]);
    await system.systemctl(['restart', APP_UNIT]);
  };
  for (const unit of [APP_UNIT, AGENT_UNIT, HOSTD_UNIT, HOSTD_SOCKET]) if (units[unit]) await system.systemctl(['stop', unit]);
  try {
    await activate(previous, leaving, previousVersion);
    await replaceSymlink(path.join(paths.installDir, 'previous'), currentDir);
    await writeRootFile(system, paths.previousDeployment, `${JSON.stringify(current, null, 2)}\n`, 0o600);
  } catch (error) {
    await activate(current, config.skipVersion, leaving);
    await replaceSymlink(path.join(paths.installDir, 'previous'), previousDir);
    throw error;
  }
  say(`OpenChamber ${previousVersion} runs again; automatic updates skip ${leaving}.`);
  return { version: previousVersion, skipped: leaving };
}
