import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isString } from '../../shared/guards.js';
import { ProtectedMcpError } from './contract.js';
import { ensurePrivateDirectory, writePrivateFile } from './store.js';

const INSTALL_TIMEOUT_MS = 10 * 60_000;

const packageKey = (command) => `${command.package.replace(/^@/, '').replace('/', '__')}@${command.version}`;

/**
 * MCP server packages the service installs into its own directory, so a
 * package-based connection never runs code from an engine-writable npm cache.
 * Install scripts do not run: they would run as the service identity.
 */
export function createRuntimes({ directory, npmCommand = null, workerPath, integrity, log = () => {}, runFile = execFile }) {
  const installing = new Map();
  const failures = new Map();
  const home = (command) => path.join(directory, packageKey(command));
  const binary = (command) => path.join(home(command), 'node_modules', '.bin', command.bin);
  const marker = (command) => path.join(home(command), '.installed.json');

  const installed = async (command) => {
    try {
      const record = JSON.parse(await fs.readFile(marker(command), 'utf8'));
      return record.package === command.package && record.version === command.version;
    } catch {
      return false;
    }
  };

  const install = (command) => {
    const key = packageKey(command);
    if (installing.has(key)) return installing.get(key);
    const work = (async () => {
      if (await installed(command)) return;
      if (!npmCommand) throw new ProtectedMcpError('package_runtime_unavailable', { status: 500 });
      for (const part of npmCommand) {
        const { findings } = await integrity.inspect(part);
        if (findings.length > 0) throw new ProtectedMcpError('untrusted_package_manager', { status: 500 });
      }
      const target = home(command);
      await ensurePrivateDirectory(directory);
      await fs.rm(target, { recursive: true, force: true });
      await ensurePrivateDirectory(target);
      const scratch = path.join(directory, '.npm');
      await ensurePrivateDirectory(scratch);
      const env = {
        PATH: workerPath,
        HOME: scratch,
        LANG: 'C.UTF-8',
        npm_config_cache: path.join(scratch, 'cache'),
        npm_config_userconfig: path.join(scratch, 'npmrc'),
        npm_config_globalconfig: path.join(scratch, 'npmrc-global'),
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
      };
      const [file, ...prefix] = npmCommand;
      await new Promise((resolve, reject) => {
        runFile(file, [...prefix, 'install', '--prefix', target, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--no-save', '--loglevel=error', `${command.package}@${command.version}`], {
          cwd: target, env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        }, (error) => (error ? reject(new ProtectedMcpError('package_install_failed', { status: 500 })) : resolve()));
      });
      await integrity.checkExecutable(binary(command));
      await writePrivateFile(marker(command), JSON.stringify({ package: command.package, version: command.version }));
      failures.delete(key);
      log('package_installed', { package: command.package, version: command.version });
    })();
    installing.set(key, work);
    work.catch((error) => {
      failures.set(key, error?.code ?? 'package_install_failed');
      log('package_install_failed', { package: command.package, version: command.version, code: error?.code ?? 'unknown' });
    }).finally(() => installing.delete(key));
    return work;
  };

  return {
    install,
    async status(command) {
      if (isString(command)) return 'ready';
      const key = packageKey(command);
      if (installing.has(key)) return 'installing';
      if (await installed(command)) return 'ready';
      return failures.has(key) ? 'failed' : 'missing';
    },
    /** The verified executable for a command, starting an install a package still needs. */
    async resolve(command) {
      if (isString(command)) return integrity.checkExecutable(command);
      if (await installed(command)) return integrity.checkExecutable(binary(command));
      const key = packageKey(command);
      if (failures.has(key) && !installing.has(key)) throw new ProtectedMcpError(failures.get(key), { status: 500 });
      install(command).catch(() => {});
      throw new ProtectedMcpError('runtime_installing', { status: 503 });
    },
  };
}
