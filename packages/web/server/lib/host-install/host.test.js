import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { layout as protectedMcpLayout } from '../protected-mcp/service/install.js';
import { APP_UNIT, install, layout, rollback, status, uninstall, update, UPDATER_PATH, UPDATER_TIMER, UPDATER_UNIT } from './host.js';
import { fakeSystem, hostRoot as fixtureRoot, linked, installOptions as optionsForInstall } from './fake-system.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const protectedCurrent = (root) => fs.readlink(path.join(protectedMcpLayout(root).installDir, 'current')).catch(() => null);
const hostRoot = () => fixtureRoot(cleanups);
const installOptions = (root, system, extra = {}) => optionsForInstall(root, system, { separation: false, ...extra });

describe('host install', () => {
  it('installs root-owned code, a unit that runs it as the owner, the protected MCP service and the updater', async () => {
    // Given
    const root = await hostRoot();
    const system = fakeSystem(root);
    // When
    const result = await install(installOptions(root, system, { port: 4000 }));
    // Then
    const paths = layout(root);
    expect(result.protectedMcp).toEqual({ status: 'installed', boundary: 'protected' });
    expect(await linked(root, 'current')).toBe('2.6.0');
    expect((await fs.stat(path.join(paths.installDir, 'current/node_modules/@openchamber/web/bin/cli.js'))).mode & 0o777).toBe(0o755);
    expect(JSON.parse(await fs.readFile(paths.configFile, 'utf8'))).toEqual({
      version: 1, owner: 'alice', repo: 'example/openchamber', port: 4000, host: '127.0.0.1', autoUpdate: true, protectedMcp: true, acceptUnprotected: false, separation: null,
    });
    const unit = (await fs.readFile(paths.unit(APP_UNIT), 'utf8')).split('\n');
    for (const line of ['User=alice', 'NoNewPrivileges=yes', 'Environment=OPENCHAMBER_UPDATE_REPO=example/openchamber',
      'ExecStart=/usr/bin/node /usr/lib/openchamber/current/node_modules/@openchamber/web/bin/cli.js serve --foreground --port 4000 --host "127.0.0.1"']) {
      expect(unit).toContain(line);
    }
    expect(await fs.readFile(paths.unit(UPDATER_UNIT), 'utf8')).toContain('ExecStart=/usr/bin/node /usr/lib/openchamber/current/node_modules/@openchamber/web/server/lib/host-install/main.js update');
    expect(await fs.readFile(paths.unit(UPDATER_PATH), 'utf8')).toContain('PathChanged=/var/lib/openchamber-host/requests/update');
    expect((await fs.stat(paths.requestDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(paths.envFile)).mode & 0o777).toBe(0o600);
    expect(await fs.readlink(paths.binLink)).toBe('/usr/lib/openchamber/current/node_modules/@openchamber/web/bin/cli.js');
    // The protected service is in place before OpenChamber starts with its groups.
    const order = system.calls.map((call) => call.flat().join(' '));
    expect(order.indexOf('protectedMcp.install 2.6.0 alice openchamber.service')).toBeLessThan(order.indexOf(`systemctl restart ${APP_UNIT}`));
    expect(order).toContain(`systemctl enable --now ${UPDATER_TIMER}`);
  });

  it('never replaces a unit another tool wrote', async () => {
    // Given
    const root = await hostRoot();
    const paths = layout(root);
    await fs.mkdir(path.dirname(paths.unit(APP_UNIT)), { recursive: true });
    await fs.writeFile(paths.unit(APP_UNIT), '[Unit]\nDescription=someone else\n');
    const system = fakeSystem(root);
    // When
    const result = install(installOptions(root, system));
    // Then
    await expect(result).rejects.toMatchObject({ code: 'unit_conflict' });
    expect(await fs.readFile(paths.unit(APP_UNIT), 'utf8')).toBe('[Unit]\nDescription=someone else\n');
    expect(system.calls).toEqual([]);
  });

  it('installs OpenCode for an owner who has none, as that owner, before switching versions', async () => {
    // Given
    const root = await hostRoot();
    await fs.rm(path.join(root, 'home/alice/.opencode'), { recursive: true });
    const system = fakeSystem(root);
    system.installOpenCode = async () => {
      system.calls.push(['installOpenCode']);
      throw new Error('network down');
    };
    // When
    const result = install(installOptions(root, system));
    // Then
    await expect(result).rejects.toMatchObject({ code: 'opencode_install_failed' });
    expect(await linked(root, 'current')).toBeNull();
    expect(system.calls.some(([name]) => name === 'systemctl')).toBe(false);
  });

  it('reinstalls the running version beside it, never in its place', async () => {
    const root = await hostRoot();
    await install(installOptions(root, fakeSystem(root)));
    const running = await fs.readlink(path.join(layout(root).installDir, 'current'));
    await install(installOptions(root, fakeSystem(root)));
    expect(await fs.readlink(path.join(layout(root).installDir, 'previous'))).toBe(running);
    expect(await fs.readlink(path.join(layout(root).installDir, 'current'))).not.toBe(running);
    expect(await linked(root, 'current')).toBe('2.6.0');
  });

  it('refuses to run OpenChamber as root', async () => {
    const root = await hostRoot();
    await expect(install(installOptions(root, fakeSystem(root), { owner: 'root' }))).rejects.toMatchObject({ code: 'owner_is_root' });
  });

  it('installs OpenChamber even when the protected MCP service refuses the host', async () => {
    // Given
    const root = await hostRoot();
    const system = fakeSystem(root, { protectedFails: true });
    // When
    const result = await install(installOptions(root, system));
    // Then
    expect(result.protectedMcp).toMatchObject({ status: 'failed', code: 'unprotected' });
    expect(system.calls).toContainEqual(['systemctl', ['restart', APP_UNIT]]);
  });

  it('keeps the running version when the latest release is not newer', async () => {
    // Given
    const root = await hostRoot();
    await install(installOptions(root, fakeSystem(root)));
    const system = fakeSystem(root, { latest: '2.6.0' });
    // When
    const result = await update({ root, system });
    // Then
    expect(result).toEqual({ version: '2.6.0', updated: false });
    expect(system.calls.some(([name]) => name === 'npm' || name === 'download')).toBe(false);
  });

  it('installs a newer release, consumes the request and keeps the old version as previous', async () => {
    // Given
    const root = await hostRoot();
    await install(installOptions(root, fakeSystem(root)));
    const paths = layout(root);
    await fs.writeFile(paths.requestFile, '');
    const system = fakeSystem(root, { latest: '2.7.0' });
    // When
    const result = await update({ root, system });
    // Then
    expect(result).toMatchObject({ version: '2.7.0', previous: '2.6.0', updated: true });
    expect(await linked(root, 'previous')).toBe('2.6.0');
    expect(await fs.stat(paths.requestFile).catch(() => null)).toBeNull();
    expect(system.calls).toContainEqual(['protectedMcp.install', '2.7.0', 'alice', APP_UNIT]);
    expect((await status({ root, system })).current).toBe('2.7.0');
  });

  it('goes back to the previous version when the new one does not start', async () => {
    // Given
    const root = await hostRoot();
    await install(installOptions(root, fakeSystem(root)));
    const system = fakeSystem(root, { latest: '2.7.0', broken: '2.7.0' });
    // When
    const result = update({ root, system });
    // Then
    await expect(result).rejects.toMatchObject({ code: 'not_started' });
    expect(await linked(root, 'current')).toBe('2.6.0');
    expect(await linked(root, 'previous')).toBeNull();
    expect(await protectedCurrent(root)).toBe('2.6.0');
    expect(system.calls.at(-1)).toEqual(['systemctl', ['restart', APP_UNIT]]);
    // And the next automatic update leaves the failed version alone.
    const next = fakeSystem(root, { latest: '2.7.0' });
    expect(await update({ root, system: next })).toEqual({ version: '2.6.0', updated: false, skipped: '2.7.0' });
    expect(next.calls.some(([name]) => name === 'npm')).toBe(false);
  });

  it('goes back when a step after the switch fails, also when the protected service refused', async () => {
    // Given
    const root = await hostRoot();
    await install(installOptions(root, fakeSystem(root)));
    const system = fakeSystem(root, { latest: '2.7.0', protectedFails: true });
    system.systemctl = async (args) => {
      if (args[0] === 'enable') throw new Error('unit masked');
    };
    // When
    const result = update({ root, system });
    // Then
    await expect(result).rejects.toThrow(/unit masked.*2\.6\.0 runs again/);
    expect(await linked(root, 'current')).toBe('2.6.0');
    expect(await protectedCurrent(root)).toBe('2.6.0');
  });

  it('refuses a release that has no host updater and keeps running the current one', async () => {
    const root = await hostRoot();
    await install(installOptions(root, fakeSystem(root)));
    const system = fakeSystem(root, { latest: '2.7.0', withoutUpdater: '2.7.0' });
    await expect(update({ root, system })).rejects.toMatchObject({ code: 'no_host_installer' });
    expect(await linked(root, 'current')).toBe('2.6.0');
    expect(system.calls.some(([name]) => name === 'systemctl')).toBe(false);
  });

  it('keeps only the current and previous versions', async () => {
    const root = await hostRoot();
    await install(installOptions(root, fakeSystem(root)));
    await update({ root, system: fakeSystem(root, { latest: '2.7.0' }) });
    await update({ root, system: fakeSystem(root, { latest: '2.8.0' }) });
    const entries = await fs.readdir(layout(root).installDir);
    expect(entries.length).toBe(4);
    expect([await linked(root, 'current'), await linked(root, 'previous')]).toEqual(['2.8.0', '2.7.0']);
  });

  it('rolls back on request and removes everything but the env file on uninstall', async () => {
    // Given
    const root = await hostRoot();
    await install(installOptions(root, fakeSystem(root)));
    await update({ root, system: fakeSystem(root, { latest: '2.7.0' }) });
    // When
    const rolledBack = await rollback({ root, system: fakeSystem(root) });
    // Then
    const paths = layout(root);
    expect(rolledBack).toEqual({ version: '2.6.0', skipped: '2.7.0' });
    expect(await linked(root, 'current')).toBe('2.6.0');
    expect(await protectedCurrent(root)).toBe('2.6.0');
    expect(await update({ root, system: fakeSystem(root, { latest: '2.7.0' }) })).toMatchObject({ updated: false, skipped: '2.7.0' });
    await fs.mkdir(paths.requestFile);
    // When
    const system = fakeSystem(root);
    await uninstall({ root, system });
    // Then
    expect(await fs.stat(paths.installDir).catch(() => null)).toBeNull();
    expect(await fs.stat(path.dirname(paths.requestDir)).catch(() => null)).toBeNull();
    expect(await fs.stat(paths.unit(APP_UNIT)).catch(() => null)).toBeNull();
    expect(await fs.stat(paths.configFile).catch(() => null)).toBeNull();
    expect(await fs.stat(paths.envFile)).not.toBeNull();
    expect(system.calls).toContainEqual(['protectedMcp.uninstall', { root, engineUser: 'alice', purgeState: false }]);
    expect(await status({ root, system })).toEqual({ installed: false });
  });
});
