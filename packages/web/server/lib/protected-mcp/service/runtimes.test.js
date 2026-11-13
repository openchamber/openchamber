import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trustedFixtureDirectory } from '../test-support/fixtures.js';
import { createIntegrity } from './integrity.js';
import { createRuntimes } from './runtimes.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const engine = { uid: 2_000_000_003, gids: [2_000_000_003] };
const command = { package: '@acme/mcp-server', version: '1.4.2', bin: 'acme-mcp' };

/**
 * Runtimes over a trusted scratch directory, with npm replaced by a recorder
 * that lays out what `npm install --prefix` would: the package's bin link.
 */
async function setup({ npmFails = false, npmDirectoryMode = 0o755 } = {}) {
  const scratch = await trustedFixtureDirectory();
  cleanups.push(scratch.remove);
  const npmDirectory = path.join(scratch.directory, 'npm');
  await fs.mkdir(npmDirectory);
  await fs.chmod(npmDirectory, npmDirectoryMode);
  const npmCli = path.join(npmDirectory, 'npm-cli.js');
  await fs.writeFile(npmCli, '');
  const calls = [];
  const runFile = (file, args, options, done) => {
    calls.push({ file, args, options });
    if (npmFails) {
      done(new Error('npm failed'));
      return;
    }
    const prefix = args[args.indexOf('--prefix') + 1];
    const packageBin = path.join(prefix, 'node_modules', '@acme', 'mcp-server', 'bin.js');
    fs.mkdir(path.dirname(packageBin), { recursive: true })
      .then(() => fs.writeFile(packageBin, '#!/usr/bin/env node\n', { mode: 0o755 }))
      .then(() => fs.mkdir(path.join(prefix, 'node_modules', '.bin'), { recursive: true }))
      .then(() => fs.symlink('../@acme/mcp-server/bin.js', path.join(prefix, 'node_modules', '.bin', 'acme-mcp')))
      .then(() => done(null), done);
  };
  const directory = path.join(scratch.directory, 'state', 'runtimes');
  const runtimes = createRuntimes({
    directory,
    npmCommand: [process.execPath, npmCli],
    workerPath: '/usr/local/bin:/usr/bin:/bin',
    integrity: createIntegrity({ owners: [0, process.getuid()], groups: [0], engine, readAcl: async () => [] }),
    runFile,
  });
  return { runtimes, calls, directory };
}

const settled = (promise) => promise.then(() => 'resolved', (error) => error.code);

describe('package runtimes', () => {
  it('installs an exact version into its own directory without install scripts, then resolves the real file', async () => {
    const { runtimes, calls, directory } = await setup();
    expect(await runtimes.status(command)).toBe('missing');
    await expect(runtimes.resolve(command)).rejects.toMatchObject({ code: 'runtime_installing' });
    expect(await runtimes.status(command)).toBe('installing');
    expect(await settled(runtimes.install(command))).toBe('resolved');
    expect(await runtimes.status(command)).toBe('ready');

    const [{ file, args, options }] = calls;
    expect(file).toBe(process.execPath);
    expect(args).toEqual(expect.arrayContaining(['install', '--ignore-scripts', '--omit=dev', '@acme/mcp-server@1.4.2']));
    const prefix = args[args.indexOf('--prefix') + 1];
    expect(prefix.startsWith(`${directory}${path.sep}`)).toBe(true);
    // npm sees no inherited environment: its home, cache and configuration live in the runtime directory.
    expect(Object.keys(options.env).sort()).toEqual([
      'HOME', 'LANG', 'PATH', 'npm_config_audit', 'npm_config_cache', 'npm_config_fund',
      'npm_config_globalconfig', 'npm_config_update_notifier', 'npm_config_userconfig',
    ]);
    expect(options.env.HOME.startsWith(directory)).toBe(true);
    expect(options.env.npm_config_userconfig.startsWith(directory)).toBe(true);

    expect(await runtimes.resolve(command)).toBe(await fs.realpath(path.join(prefix, 'node_modules', '@acme', 'mcp-server', 'bin.js')));
    expect((await fs.stat(prefix)).mode & 0o077).toBe(0);
    // Installed once: a second install does not run npm again.
    await runtimes.install(command);
    expect(calls).toHaveLength(1);
  });

  it('reports a failed install instead of retrying it on every session', async () => {
    const { runtimes, calls } = await setup({ npmFails: true });
    expect(await settled(runtimes.install(command))).toBe('package_install_failed');
    expect(await runtimes.status(command)).toBe('failed');
    await expect(runtimes.resolve(command)).rejects.toMatchObject({ code: 'package_install_failed' });
    expect(calls).toHaveLength(1);
  });

  it('refuses to run an npm the engine could change', async () => {
    const { runtimes, calls } = await setup({ npmDirectoryMode: 0o777 });
    expect(await settled(runtimes.install(command))).toBe('untrusted_package_manager');
    expect(calls).toEqual([]);
    expect(await runtimes.status(command)).toBe('failed');
  });

  it('refuses an installed binary the engine could change', async () => {
    const { runtimes, directory } = await setup();
    await runtimes.install(command);
    const packageDirectory = (await fs.readdir(directory)).find((name) => name.startsWith('acme__mcp-server@'));
    await fs.chmod(path.join(directory, packageDirectory, 'node_modules', '@acme', 'mcp-server'), 0o777);
    await expect(runtimes.resolve(command)).rejects.toMatchObject({ code: 'untrusted_executable' });
  });
});
